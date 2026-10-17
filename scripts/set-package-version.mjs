/**
 * Stamp the release version onto every publishable package manifest.
 *
 * switchback releases are tagged, never version-bumped in Git (see
 * `docs/versioning.md`): the CalVer tag is authoritative and `package.json`
 * keeps the version it was scaffolded with. npm still needs a version to
 * publish, so the publishing workflow runs this script in the runner only - the
 * rewritten manifests are never committed.
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
	writeFileSync(manifestPath, text.replace(versionField, `$1${version}$2`));
	console.log(`${name} -> ${version}`);
}
