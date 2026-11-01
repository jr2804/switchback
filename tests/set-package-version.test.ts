/**
 * Guard for `scripts/set-package-version.mjs`.
 *
 * The script is the only thing that gives npm a version (switchback releases are
 * tagged, never version-bumped in Git), so whatever it leaves in the manifests is
 * what lands on the registry. It used to stamp only each package's own `version`,
 * leaving the adapters declaring a caret range on `switchback-core` - and npm
 * resolved an older core than the adapter imports from, which broke the pi
 * extension at load time with "(0, _config.createConfigWarningReporter) is not a
 * function". This test runs the real script against a throwaway copy of the
 * manifests and pins both halves of the fix: the workspace version is the tag AND
 * every sibling dependency is pinned to that exact tag.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const WORKSPACES = ["core", "pi", "opencode"] as const;
const TAG = "v2026.11.1";
const VERSION = "2026.11.1";

let sandbox: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "switchback-version-"));
	cpSync(join(ROOT, "scripts"), join(sandbox, "scripts"), { recursive: true });
	for (const workspace of WORKSPACES) {
		cpSync(join(ROOT, "packages", workspace, "package.json"), join(sandbox, "packages", workspace, "package.json"), {
			recursive: false,
		});
	}
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

function manifest(workspace: (typeof WORKSPACES)[number]) {
	return JSON.parse(readFileSync(join(sandbox, "packages", workspace, "package.json"), "utf8")) as {
		name: string;
		version: string;
		dependencies?: Record<string, string>;
	};
}

function stamp(tag = TAG): void {
	execFileSync("node", [join(sandbox, "scripts", "set-package-version.mjs"), tag], { cwd: sandbox, stdio: "pipe" });
}

describe("set-package-version", () => {
	it("writes the tag into every workspace version", () => {
		stamp();
		for (const workspace of WORKSPACES) expect(manifest(workspace).version).toBe(VERSION);
	});

	it("pins a sibling workspace dependency to the exact release", () => {
		// The bug: adapters shipped "^2026.10.1", which permits any 2026.x core.
		expect(manifest("pi").dependencies?.["switchback-core"]).not.toBe(VERSION);
		stamp();
		expect(manifest("pi").dependencies?.["switchback-core"]).toBe(VERSION);
		expect(manifest("opencode").dependencies?.["switchback-core"]).toBe(VERSION);
	});

	it("leaves the core package itself without a self-dependency", () => {
		stamp();
		expect(manifest("core").dependencies?.["switchback-core"]).toBeUndefined();
	});

	it("does not touch third-party dependency ranges", () => {
		const path = join(sandbox, "packages", "core", "package.json");
		const parsed = manifest("core") as { dependencies?: Record<string, string> };
		parsed.dependencies = { ...(parsed.dependencies ?? {}), yaml: "^2.9.1" };
		writeFileSync(path, JSON.stringify(parsed, null, "\t"));
		stamp();
		expect(manifest("core").dependencies?.["yaml"]).toBe("^2.9.1");
	});

	it("rejects a tag that is not CalVer", () => {
		expect(() => stamp("v1.2.3")).toThrow();
	});
});
