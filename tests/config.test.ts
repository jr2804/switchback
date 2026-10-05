/**
 * Config tests - separate from router.test.ts to keep the file focused.
 * Covers DEFAULT_CONFIG's empty-fallback design and findModelConfig's
 * actionable error message when the shipped default is the active source.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DEFAULT_CONFIG, findModelConfig, loadConfig, ConfigError, SWITCHBACK_PROVIDER, SWITCHBACK_VIRTUAL_ID } from "../src/config.ts";
import { registerLocalClassifier } from "../src/local-classifier.ts";

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
	originalCwd = process.cwd();
	tmpDir = join(tmpdir(), `switchback-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tmpDir, { recursive: true });
	// Point pi's config dir at the tmp dir so the test is portable and doesn't pick
	// up the user's activated agent-dir copy.
	process.env["PI_CODING_AGENT_DIR"] = tmpDir;
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	delete process.env["PI_CODING_AGENT_DIR"];
	if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("DEFAULT_CONFIG", () => {
	it("has empty fallbacks on purpose (forces user to ship a config)", () => {
		const auto = DEFAULT_CONFIG.models.find((m) => m.id === `${SWITCHBACK_PROVIDER}/${SWITCHBACK_VIRTUAL_ID}`);
		expect(auto).toBeDefined();
		expect(auto?.fallbacks).toEqual([]);
	});

	it("findModelConfig on DEFAULT_CONFIG throws ConfigError naming the fix", () => {
		expect(() => findModelConfig(DEFAULT_CONFIG, `${SWITCHBACK_PROVIDER}/${SWITCHBACK_VIRTUAL_ID}`)).toThrow(ConfigError);
		try {
			findModelConfig(DEFAULT_CONFIG, `${SWITCHBACK_PROVIDER}/${SWITCHBACK_VIRTUAL_ID}`);
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).message).toContain("no fallbacks configured");
			expect((err as ConfigError).message).toContain("switchback.yaml");
			expect((err as ConfigError).path).toBe("<default>");
		}
	});

	it("loadConfig with no user files falls back to DEFAULT_CONFIG with source '<default>'", () => {
		const { config, source } = loadConfig();
		expect(source).toBe("<default>");
		expect(config.models[0]?.fallbacks).toEqual([]);
	});
});

describe("loadConfig - layer aggregation", () => {
	const writeProject = (yaml: string): void => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(join(tmpDir, ".pi", "switchback.yaml"), yaml);
	};
	const writeAgent = (yaml: string): void => {
		mkdirSync(join(tmpDir, "agent"), { recursive: true });
		process.env["PI_CODING_AGENT_DIR"] = join(tmpDir, "agent");
		writeFileSync(join(tmpDir, "agent", "switchback.yaml"), yaml);
	};

	it("a duplicated model id means the project entry wins wholesale", () => {
		writeProject(`models:
  - id: switchback/auto
    name: project override
    fallbacks: ["zai/glm-5.3"]
`);
		writeAgent(`models:
  - id: switchback/auto
    name: agent-dir copy
    fallbacks: ["ollama-cloud/glm-5.3-flash"]
`);
		const { config, source } = loadConfig();
		expect(config.models).toHaveLength(1);
		expect(config.models[0]?.name).toBe("project override");
		expect(config.models[0]?.fallbacks).toEqual(["zai/glm-5.3"]);
		expect(source).toContain(join(tmpDir, ".pi", "switchback.yaml"));
		expect(source).toContain(join(tmpDir, "agent", "switchback.yaml"));
	});

	it("keeps global order, overrides in place, appends project-only models", () => {
		writeProject(`models:
  - id: switchback/local
    name: Project Only
    fallbacks: ["minimax/MiniMax-M3"]
  - id: switchback/auto
    name: project override
    fallbacks: ["zai/glm-5.3"]
`);
		writeAgent(`models:
  - id: switchback/auto
    name: agent auto
    fallbacks: ["zai/glm-5.3"]
  - id: switchback/auto-flash
    name: agent flash
    fallbacks: ["zai/glm-5.3-flash"]
`);
		const { config } = loadConfig();
		expect(config.models.map((m) => `${m.id}:${m.name}`)).toEqual([
			"switchback/auto:project override",
			"switchback/auto-flash:agent flash",
			"switchback/local:Project Only",
		]);
	});

	it("agent-dir copy is used verbatim when no project layer exists", () => {
		writeAgent(`models:
  - id: switchback/auto
    name: agent-dir copy
    fallbacks: ["ollama-cloud/glm-5.3-flash"]
`);
		const { config, source } = loadConfig();
		expect(config.models[0]?.name).toBe("agent-dir copy");
		expect(source).toBe(resolve(join(tmpDir, "agent", "switchback.yaml")));
	});

	it("a broken project layer throws even when the global layer is valid", () => {
		writeProject("models: definitely: not: a: list\n");
		writeAgent(`models:
  - id: switchback/auto
    name: agent-dir copy
    fallbacks: ["ollama-cloud/glm-5.3-flash"]
`);
		expect(() => loadConfig()).toThrow(ConfigError);
	});
});

describe("loadConfig - yaml-only lookup (no JSON user config)", () => {
	it("does not consider switchback.json in the candidate list", () => {
		// Ship a switchback.json next to the project-local yaml slot. The loader
		// should NOT pick it up - user config is YAML only.
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(join(tmpDir, ".pi", "switchback.json"), JSON.stringify({
			models: [{ id: "switchback/auto", name: "should be ignored", fallbacks: ["zai/glm-5.3"] }],
		}));
		const { config, source } = loadConfig();
		expect(source).toBe("<default>");
		expect(config.models[0]?.name).toBe("Auto (Switchback)");
		expect(config.models[0]?.fallbacks).toEqual([]);
	});
});

describe("loadConfig - classifier endpoint fields (jev.baseUrl)", () => {
	const writeConfig = (jevLines: string): void => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "switchback.yaml"),
			`models:\n  - id: switchback/auto\n    name: Auto (Switchback)\n    fallbacks: ["zai/glm-5.3"]\n    jev:\n${jevLines}`,
		);
	};

	it("parses a direct endpoint (baseUrl + api + apiKey)", () => {
		writeConfig(
			"      provider: ollama-systemone\n      id: tev1:0.8b\n      baseUrl: http://localhost:11434/v1\n      api: typesafe-system-one\n      apiKey: ollama\n",
		);
		const { config } = loadConfig();
		expect(config.models[0]?.jev).toEqual({
			provider: "ollama-systemone",
			id: "tev1:0.8b",
			baseUrl: "http://localhost:11434/v1",
			api: "typesafe-system-one",
			apiKey: "ollama",
		});
	});

	it("leaves a catalog classifier untouched (provider + id only)", () => {
		writeConfig("      provider: typesafe\n      id: jev-latest\n");
		const { config } = loadConfig();
		expect(config.models[0]?.jev).toEqual({ provider: "typesafe", id: "jev-latest" });
	});

	it("rejects an unsupported api", () => {
		writeConfig("      provider: x\n      id: y\n      baseUrl: http://localhost:1/v1\n      api: openai-completions\n");
		expect(() => loadConfig()).toThrow(/jev\.api must be one of/);
	});

	it("rejects api without baseUrl", () => {
		writeConfig("      provider: x\n      id: y\n      api: typesafe-system-one\n");
		expect(() => loadConfig()).toThrow(/jev\.api requires/);
	});

	it("rejects apiKey without baseUrl", () => {
		writeConfig("      provider: x\n      id: y\n      apiKey: secret\n");
		expect(() => loadConfig()).toThrow(/jev\.apiKey requires/);
	});

	it("rejects a non-http(s) baseUrl", () => {
		writeConfig("      provider: x\n      id: y\n      baseUrl: ftp://localhost/v1\n");
		expect(() => loadConfig()).toThrow(/must be http\(s\)/);
	});
});

describe("registerLocalClassifier", () => {
	interface Captured {
		id: string;
		cfg: { models?: { type?: string; id: string }[]; classifiers?: Record<string, unknown> };
	}

	it("registers exactly one classifier model and the transport for a direct endpoint", () => {
		const captured: Captured[] = [];
		registerLocalClassifier(
			{ registerProvider: (id: string, cfg: never) => captured.push({ id, cfg }) } as never,
			{ provider: "ollama-systemone", id: "tev1:0.8b", baseUrl: "http://localhost:11434/v1", apiKey: "ollama" },
		);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.id).toBe("ollama-systemone");
		expect(captured[0]?.cfg.models).toHaveLength(1);
		expect(captured[0]?.cfg.models?.[0]?.type).toBe("classifier");
		expect(Object.keys(captured[0]?.cfg.classifiers ?? {})).toEqual(["typesafe-system-one"]);
	});

	it("is a no-op without baseUrl (catalog classifier path)", () => {
		let called = 0;
		registerLocalClassifier(
			{ registerProvider: () => { called += 1; } } as never,
			{ provider: "typesafe", id: "jev-latest" },
		);
		expect(called).toBe(0);
	});

	it("is a no-op when there is no classifier at all", () => {
		let called = 0;
		registerLocalClassifier({ registerProvider: () => { called += 1; } } as never, undefined);
		expect(called).toBe(0);
	});
});