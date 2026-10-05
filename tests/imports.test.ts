/**
 * Guard: shipped code must never import a deep subpath of a host-provided
 * package at runtime.
 *
 * Pi supplies `@earendil-works/pi-ai` (and the other host packages) to
 * extensions by BARE SPECIFIER only. A deep subpath such as
 * `@earendil-works/pi-ai/api/typesafe-system-one.lazy` resolves fine inside
 * this repository - which has its own node_modules - but fails with
 * "Cannot find module" in a package installed by `pi install`, which is
 * exactly how switchback v1 shipped broken (fixed in src/systemone.ts).
 *
 * Type-only imports are erased before the module is evaluated, so they are
 * safe. Value imports of subpaths are not. This test pins that distinction.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const HOST_SUBPATH = /["']@earendil-works\/pi-ai\//;

function shippedFiles(): string[] {
	const srcDir = join(REPO, "src");
	const src = readdirSync(srcDir)
		.filter((f) => f.endsWith(".ts"))
		.map((f) => join(srcDir, f));
	return [join(REPO, "index.ts"), ...src];
}

describe("shipped imports", () => {
	it("never value-imports a host-package subpath (install-safe)", () => {
		const offenders: string[] = [];
		for (const file of shippedFiles()) {
			const lines = readFileSync(file, "utf8").split("\n");
			lines.forEach((line, index) => {
				if (!HOST_SUBPATH.test(line)) return;
				const trimmed = line.trim();
				// Comments may mention the specifier (e.g. explaining why it is avoided).
				if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
				// Type-only imports are erased at load and resolve nothing.
				if (trimmed.includes("import type")) return;
				offenders.push(`${file.replace(REPO, "")}:${index + 1}: ${trimmed}`);
			});
		}
		expect(offenders, `host-package subpath imports are not install-safe:\n${offenders.join("\n")}`).toEqual([]);
	});

	it("ships the System One transport itself rather than importing pi's", () => {
		const classifier = readFileSync(join(REPO, "src", "local-classifier.ts"), "utf8");
		expect(classifier).toContain('from "./systemone.ts"');
		expect(classifier).not.toMatch(/^import\s+\{[^}]*\}\s+from\s+"@earendil-works\/pi-ai\//m);
	});
});
