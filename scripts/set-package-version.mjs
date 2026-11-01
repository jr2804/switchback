/**
 * Stamp the release version onto every publishable package manifest.
 *
 * switchback releases are tagged, never version-bumped in Git (see
 * `docs/versioning.md`): the CalVer tag is authoritative and `package.json`
 * keeps the version it was scaffolded with. npm still needs a version to
 * publish, so the publishing workflow runs this script in the runner only - the
 * rewritten manifests are never committed.
 *
 * Workspace dependencies are pinned to the tag as well. Stamping only `version`
 * left the adapters declaring `"switchback-core": "^<scaffolded version>"`, a
 * caret that permits any `2026.x` core, and npm happily resolved an older core
 * than the adapter was built against: `pi-switchback` then imported a symbol the
 * installed core did not have and the extension failed to load. The workflow
 * publishes core first precisely so an adapter never points at a missing core;
 * pinning the range makes that guarantee real, because a caret could still
 * resolve backwards to a core from before the code the adapter needs.
 *
 * Usage: node scripts/set-package-version.mjs v2026.10.1 [--packages core,pi]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACES = ["core", "pi", "opencode"];

const tag = process.argv[2] ?? "";
const requested = process.argv.indexOf("--packages");
const selected = requested === -1 ? WORKSPACES : (process.argv[requested + 1] ?? "").split(",").filter(Boolean);

const version = tag.replace(/^v/, "");
if (!/^\d{4}\.\d{1,2}\.\d+$/.test(version)) {
	console.error(`set-package-version: "${tag}" is not a CalVer tag of the form vYYYY.M.N`);
	process.exit(1);
}

const manifestPaths = WORKSPACES.map((workspace) => join("packages", workspace, "package.json"));
// Workspace package names, so a dependency on a sibling case is pinned to the tag.
const workspaceNames = manifestPaths.map((path) => JSON.parse(readFileSync(path, "utf8")).name);

/**
 * Rewrite a published dependency range on a sibling workspace to the exact tag.
 * Returns the input unchanged when the name is not a workspace package, so
 * third-party ranges keep whatever the manifest declares.
 */
function pinWorkspaceRange(text, name, pinned) {
	if (!workspaceNames.includes(name)) return text;
	// Match `"name": "<range>"` with any range (caret, tilde, exact, workspace:*).
	const pattern = new RegExp(`("${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}":\\s*")[^"]*(")`);
	return text.replace(pattern, `$1${pinned}$2`);
}

for (const workspace of selected) {
	if (!WORKSPACES.includes(workspace)) {
		console.error(
			`set-package-version: unknown workspace "${workspace}" (expected one of ${WORKSPACES.join(", ")})`,
		);
		process.exit(1);
	}
	const manifestPath = join("packages", workspace, "package.json");
	const text = readFileSync(manifestPath, "utf8");
	const name = JSON.parse(text).name;
	const versionField = /("version":\s*")[^"]*(")/;
	if (!versionField.test(text)) {
		console.error(`set-package-version: no version field in ${manifestPath}`);
		process.exit(1);
	}
	let next = text.replace(versionField, `$1${version}$2`);
	// Pin every sibling workspace dependency to this release, so the published
	// adapter cannot pair with an older core (see the header).
	for (const sibling of workspaceNames) {
		if (sibling === name) continue;
		next = pinWorkspaceRange(next, sibling, version);
	}
	writeFileSync(manifestPath, next);
	console.log(`${name} -> ${version}`);
}
