#!/usr/bin/env node
// Local release trigger for the CalVer automation.
//
// `mise run release` dispatches .github/workflows/calver-release.yml on
// origin/main and watches the run through tag + GitHub release + npm publish.
// This is the manual escape hatch for tips whose head commit says
// "[skip release]" (a dispatch overrides the marker) and for repairing a
// release that never happened.
//
// Before dispatching, the script refuses to run unless the working tree is
// clean and local main is identical to origin/main - whatever CI releases
// must be exactly what was verified locally.
//
// Why dispatch calver-release instead of pushing a tag: npm trusted
// publishing validates the *calling* workflow filename, and the packages'
// registrations name calver-release.yml. A manually pushed tag runs
// publish-npm.yml directly, which is a different registration (and has
// failed with E404 on PUT for exactly this reason).

import { execFileSync } from "node:child_process";

const CALVER_TAG = /^v(\d{4})\.(\d{2})\.(\d+)$/u;

/** @param {string} cmd @param {string[]} args @param {import("node:child_process").ExecFileSyncOptions} [opts] */
function run(cmd, args, opts = {}) {
	return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** @param {string[]} args @returns {string} git output, trailing newline trimmed; empty string when git exits non-zero */
function gitOk(args) {
	try {
		return run("git", args).trim();
	} catch {
		return "";
	}
}

function fail(message) {
	console.error(`release: ${message}`);
	process.exit(1);
}

// --- guards: release exactly what was verified locally -----------------------

const dirty = gitOk(["status", "--porcelain"]);
if (dirty !== "") fail("working tree is not clean - commit or stash first");

const branch = gitOk(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") fail(`not on main (on "${branch || "detached HEAD"}")`);

try {
	run("git", ["fetch", "origin", "main", "--tags"], { stdio: "inherit" });
} catch (error) {
	fail(`git fetch failed: ${error.message}`);
}

if (gitOk(["rev-list", "origin/main..HEAD"]) !== "") {
	fail("local main has unpushed commits - push first");
}
if (gitOk(["rev-list", "HEAD..origin/main"]) !== "") {
	fail("local main is behind origin/main - pull first");
}

const headTag = gitOk(["describe", "--tags", "--exact-match", "HEAD"]);
if (CALVER_TAG.test(headTag)) {
	fail(
		`HEAD is already tagged ${headTag}. Re-publish that version instead: ` +
			`gh workflow run publish-npm.yml -f tag=${headTag} -f dry_run=false`,
	);
}

// --- compute the tag the workflow will create (for reporting only) ----------

const now = new Date().toISOString(); // the workflow dates with `date -u` too
const prefix = `v${now.slice(0, 4)}.${now.slice(5, 7)}.`;
let max = 0;
for (const line of gitOk(["ls-remote", "--tags", "origin", `refs/tags/${prefix}*`]).split("\n")) {
	const match = /refs\/tags\/(v\d{4}\.\d{2}\.(\d+))$/u.exec(line.trim());
	if (match) max = Math.max(max, Number(match[2]));
}
const expectedTag = `${prefix}${max + 1}`;

// --- dispatch and watch ------------------------------------------------------

try {
	run("gh", ["workflow", "run", "calver-release.yml", "--ref", "main"], { stdio: "inherit" });
} catch (error) {
	fail(`dispatch failed: ${error.message}`);
}

console.log(`release: dispatched calver-release.yml on main (expecting ${expectedTag}); waiting for the run...`);

// The dispatched run needs a moment to register; poll for it.
const startedAt = Date.now();
/** @type {string | undefined} */
let runId;
while (Date.now() - startedAt < 60_000) {
	const list = run("gh", [
		"run",
		"list",
		"--workflow",
		"calver-release.yml",
		"--json",
		"databaseId,event,status,createdAt",
		"--limit",
		"10",
	]);
	for (const item of JSON.parse(list)) {
		if (item.event === "workflow_dispatch" && Date.parse(item.createdAt) >= startedAt - 30_000) {
			runId = String(item.databaseId);
			break;
		}
	}
	if (runId) break;
	await new Promise((resolve) => setTimeout(resolve, 5_000));
}
if (!runId) fail("could not find the dispatched run - check https://github.com/jr2804/switchback/actions");

try {
	run("gh", ["run", "watch", runId, "--exit-status"], { stdio: "inherit" });
} catch {
	fail(`run ${runId} failed - inspect it at https://github.com/jr2804/switchback/actions/runs/${runId}`);
}

const url = (() => {
	try {
		return run("gh", ["release", "view", expectedTag, "--json", "url", "-q", ".url"]).trim();
	} catch {
		return "";
	}
})();
console.log(`release: ${expectedTag} released${url ? ` - ${url}` : ` (release not visible yet; expected tag ${expectedTag})`}`);
console.log("release: verify the registry with: npm view switchback-core version");
