/**
 * Per-host overlay tests: `switchback.pi.yaml` / `switchback.oc.yaml` merge
 * over the shared `switchback.yaml` base when the host asks for them in
 * `loadConfig(secrets, host)`. No host arg means the base alone.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "switchback-core/config.ts";

let originalCwd: string;
let tmpDir: string;

const BASE = `models:
  - id: switchback/auto
    name: shared
    fallbacks: ["zai/glm-5.3"]
`;

function write(rel: string, yaml: string): void {
	mkdirSync(tmpDir, { recursive: true });
	writeFileSync(join(tmpDir, rel), yaml);
}

beforeEach(() => {
	originalCwd = process.cwd();
	tmpDir = join(tmpdir(), `switchback-overlays-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env["SWITCHBACK_CONFIG_DIR"] = tmpDir;
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	delete process.env["SWITCHBACK_CONFIG_DIR"];
	if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("loadConfig - per-host overlays", () => {
	it("reads the base alone when no host is given, even with overlays present", () => {
		write("switchback.yaml", BASE);
		write(
			"switchback.pi.yaml",
			'models:\n  - id: switchback/auto\n    name: pi only\n    fallbacks: ["ollama/tev1:0.8b"]\n',
		);
		const { config, source } = loadConfig();
		expect(config.models[0]?.name).toBe("shared");
		expect(source).not.toContain("switchback.pi.yaml");
	});

	it("skips a missing overlay file without complaint", () => {
		write("switchback.yaml", BASE);
		const { config, warnings } = loadConfig(undefined, "pi");
		expect(config.models[0]?.name).toBe("shared");
		expect(warnings).toEqual([]);
	});

	it("an overlay entry with a known id replaces the base entry in place", () => {
		write("switchback.yaml", BASE);
		write(
			"switchback.pi.yaml",
			'models:\n  - id: switchback/auto\n    name: pi only\n    fallbacks: ["ollama/tev1:0.8b"]\n',
		);
		const { config, source } = loadConfig(undefined, "pi");
		expect(config.models).toHaveLength(1);
		expect(config.models[0]?.name).toBe("pi only");
		expect(config.models[0]?.fallbacks).toEqual(["ollama/tev1:0.8b"]);
		expect(source).toContain("switchback.pi.yaml");
	});

	it("an overlay entry with a new id is appended, and the other host is unaffected", () => {
		write("switchback.yaml", BASE);
		write(
			"switchback.oc.yaml",
			'models:\n  - id: switchback/free\n    name: free\n    fallbacks: ["zai/glm-5.3"]\n',
		);
		const oc = loadConfig(undefined, "opencode");
		expect(oc.config.models.map((m) => m.id)).toEqual(["switchback/auto", "switchback/free"]);
		const pi = loadConfig(undefined, "pi");
		expect(pi.config.models.map((m) => m.id)).toEqual(["switchback/auto"]);
	});

	it("decisionModels merge per key with the overlay winning", () => {
		write("switchback.yaml", `${BASE}decisionModels:\n  typesafe/jev-latest: {}\n`);
		write(
			"switchback.oc.yaml",
			'decisionModels:\n  typesafe/jev-latest:\n    baseUrl: "https://example.invalid/v1"\n    apiKey: "secret:ts-key"\n',
		);
		const oc = loadConfig({ get: (name) => (name === "ts-key" ? "k" : undefined) }, "opencode");
		expect(oc.config.decisionModels?.["typesafe/jev-latest"]?.baseUrl).toBe("https://example.invalid/v1");
		const pi = loadConfig(undefined, "pi");
		expect(pi.config.decisionModels?.["typesafe/jev-latest"]).toMatchObject({
			provider: "typesafe",
			id: "jev-latest",
		});
	});

	it("a broken overlay throws rather than being skipped", () => {
		write("switchback.yaml", BASE);
		write("switchback.pi.yaml", "models: definitely: not: a: list\n");
		expect(() => loadConfig(undefined, "pi")).toThrow();
	});

	it("an overlay alone (no base file) still loads", () => {
		write(
			"switchback.oc.yaml",
			'models:\n  - id: switchback/free\n    name: free\n    fallbacks: ["zai/glm-5.3"]\n',
		);
		const { config, source } = loadConfig(undefined, "opencode");
		expect(config.models.map((m) => m.id)).toEqual(["switchback/free"]);
		expect(source).toContain("switchback.oc.yaml");
	});
});
