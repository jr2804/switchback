/**
 * Config tests - separate from router.test.ts to keep the file focused.
 * Covers DEFAULT_CONFIG's empty-fallback design and findModelConfig's
 * actionable error message when the shipped default is the active source.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
	DEFAULT_CONFIG,
	findModelConfig,
	loadConfig,
	ConfigError,
	SWITCHBACK_PROVIDER,
	SWITCHBACK_VIRTUAL_ID,
} from "switchback-core/config.ts";
import { groupLocalEndpoints, registerLocalClassifier } from "pi-switchback/local-classifier.ts";

let originalCwd: string;
let tmpDir: string;

/** The one config file these tests write: `<tmp>/switchback.yaml`. */
const configFile = (): string => join(tmpDir, "switchback.yaml");

/** Write the shared config file, creating the directory on demand. */
function writeConfig(yaml: string): void {
	mkdirSync(tmpDir, { recursive: true });
	writeFileSync(configFile(), yaml);
}

beforeEach(() => {
	originalCwd = process.cwd();
	tmpDir = join(tmpdir(), `switchback-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tmpDir, { recursive: true });
	// The config lives at `~/.config/switchback/switchback.yaml`; USERPROFILE and
	// SWITCHBACK_CONFIG_DIR both point into the temp dir so the suite is hermetic.
	process.env["SWITCHBACK_CONFIG_DIR"] = tmpDir;
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	delete process.env["SWITCHBACK_CONFIG_DIR"];
	if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("DEFAULT_CONFIG", () => {
	it("has empty fallbacks on purpose (forces user to ship a config)", () => {
		const auto = DEFAULT_CONFIG.models.find((m) => m.id === `${SWITCHBACK_PROVIDER}/${SWITCHBACK_VIRTUAL_ID}`);
		expect(auto).toBeDefined();
		expect(auto?.fallbacks).toEqual([]);
	});

	it("findModelConfig on DEFAULT_CONFIG throws ConfigError naming the fix", () => {
		expect(() => findModelConfig(DEFAULT_CONFIG, `${SWITCHBACK_PROVIDER}/${SWITCHBACK_VIRTUAL_ID}`)).toThrow(
			ConfigError,
		);
		try {
			findModelConfig(DEFAULT_CONFIG, `${SWITCHBACK_PROVIDER}/${SWITCHBACK_VIRTUAL_ID}`);
		} catch (err) {
			expect(err).toBeInstanceOf(ConfigError);
			expect((err as ConfigError).message).toContain("no fallbacks configured");
			expect((err as ConfigError).message).toContain("switchback.yaml");
			expect((err as ConfigError).path).toBe("<default>");
		}
	});

	it("loadConfig with no config file falls back to DEFAULT_CONFIG with source '<default>'", () => {
		const { config, source } = loadConfig();
		expect(source).toBe("<default>");
		expect(config.models[0]?.fallbacks).toEqual([]);
	});
});

describe("loadConfig - one file, no layers", () => {
	it("reads ~/.config/switchback/switchback.yaml and reports its path as the source", () => {
		writeConfig(`models:
  - id: switchback/auto
    name: shared
    fallbacks: ["zai/glm-5.3"]
`);
		const { config, source } = loadConfig();
		expect(config.models[0]?.name).toBe("shared");
		expect(source).toBe(resolve(configFile()));
	});

	it("ignores pi's agent overlay even when it holds a different chain set", () => {
		// The bug this contract exists for: OpenCode used to read this file.
		writeConfig(`models:
  - id: switchback/auto
    name: shared
    fallbacks: ["zai/glm-5.3"]
`);
		mkdirSync(join(tmpDir, "agent"), { recursive: true });
		process.env["PI_CODING_AGENT_DIR"] = join(tmpDir, "agent");
		writeFileSync(
			join(tmpDir, "agent", "switchback.yaml"),
			'models:\n  - id: switchback/auto\n    name: pi only\n    fallbacks: ["ollama/tev1:0.8b"]\n',
		);
		const { config, source } = loadConfig();
		expect(config.models[0]?.name).toBe("shared");
		expect(config.models[0]?.fallbacks).toEqual(["zai/glm-5.3"]);
		expect(source).not.toContain("agent");
		delete process.env["PI_CODING_AGENT_DIR"];
	});

	it("ignores a per-project <.cwd>/.pi/switchback.yaml", () => {
		writeConfig(`models:
  - id: switchback/auto
    name: shared
    fallbacks: ["zai/glm-5.3"]
`);
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "switchback.yaml"),
			'models:\n  - id: switchback/auto\n    name: project override\n    fallbacks: ["minimax/MiniMax-M3"]\n',
		);
		const { config } = loadConfig();
		expect(config.models[0]?.name).toBe("shared");
		expect(config.models[0]?.fallbacks).toEqual(["zai/glm-5.3"]);
	});

	it("a broken config file throws rather than being skipped", () => {
		writeConfig("models: definitely: not: a: list\n");
		expect(() => loadConfig()).toThrow(ConfigError);
	});
});

describe("loadConfig - yaml-only lookup (no JSON user config)", () => {
	it("does not consider a switchback.json sibling", () => {
		// User config is YAML only; a .json file next to it is not a candidate.
		mkdirSync(tmpDir, { recursive: true });
		writeFileSync(
			join(tmpDir, "switchback.json"),
			JSON.stringify({
				models: [{ id: "switchback/auto", name: "should be ignored", fallbacks: ["zai/glm-5.3"] }],
			}),
		);
		const { config, source } = loadConfig();
		expect(source).toBe("<default>");
		expect(config.models[0]?.name).toBe("Auto (Switchback)");
		expect(config.models[0]?.fallbacks).toEqual([]);
	});
});

describe("loadConfig - bare ids and decision-model addresses", () => {
	const writeWith = (modelsYaml: string, decisionModelsYaml = ""): void => {
		writeConfig(`models:\n  ${modelsYaml}\n${decisionModelsYaml}`);
	};

	it("normalises a bare model id (auto → switchback/auto)", () => {
		writeWith(`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]`);
		const { config } = loadConfig();
		expect(config.models[0]?.id).toBe("switchback/auto");
	});

	it("resolves a decisionModel address against the decisionModels map", () => {
		writeWith(
			`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]
    decisionModel: typesafe/jev-latest`,
			`decisionModels:
  typesafe/jev-latest:
    baseUrl: http://localhost:11434/v1
    apiKey: ollama
`,
		);
		const { config } = loadConfig();
		expect(config.models[0]?.decisionModel).toEqual({
			provider: "typesafe",
			id: "jev-latest",
			baseUrl: "http://localhost:11434/v1",
			apiKey: "ollama",
		});
	});

	it("leaves an address with no entry for catalog resolution (provider + id only)", () => {
		writeWith(`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]
    decisionModel: typesafe/jev-latest`);
		const { config, warnings } = loadConfig();
		expect(config.models[0]?.decisionModel).toEqual({ provider: "typesafe", id: "jev-latest" });
		expect(warnings).toEqual([]);
	});

	it("rejects an address without a provider", () => {
		writeWith(`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]
    decisionModel: jev-latest`);
		expect(() => loadConfig()).toThrow(/decisionModel must be of the form "provider\/id"/);
	});

	it("warns about a decisionModels entry nothing names", () => {
		writeWith(
			`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]`,
			`decisionModels:
  typesafe/jev-latest:
    baseUrl: http://localhost:11434/v1
    apiKey: ollama
`,
		);
		const { warnings } = loadConfig();
		expect(warnings.join("\n")).toMatch(/not referenced by any models\[\]\.decisionModel/);
	});
});

describe("loadConfig - debug flag", () => {
	const writeWith = (yaml: string): void => {
		writeConfig(yaml);
	};

	it("parses a top-level debug flag", () => {
		writeWith('debug: true\nmodels:\n  - id: switchback/auto\n    name: A\n    fallbacks: ["zai/glm-5.3"]\n');
		const { config } = loadConfig();
		expect(config.debug).toBe(true);
	});

	it("rejects a non-boolean debug value", () => {
		writeWith('debug: verbose\nmodels:\n  - id: switchback/auto\n    name: A\n    fallbacks: ["zai/glm-5.3"]\n');
		expect(() => loadConfig()).toThrow(/debug must be a boolean/);
	});

	it("the project layer's debug flag wins over the global layer's", () => {
		writeWith('debug: false\nmodels:\n  - id: switchback/auto\n    name: A\n    fallbacks: ["zai/glm-5.3"]\n');
		mkdirSync(join(tmpDir, "agent"), { recursive: true });
		process.env["PI_CODING_AGENT_DIR"] = join(tmpDir, "agent");
		writeFileSync(
			join(tmpDir, "agent", "switchback.yaml"),
			'debug: true\nmodels:\n  - id: switchback/auto\n    name: B\n    fallbacks: ["zai/glm-5.3"]\n',
		);
		const { config } = loadConfig();
		expect(config.debug).toBe(false);
	});
});

describe("loadConfig - decision model connection details", () => {
	const writeDecisionConfig = (entryLines: string, address = "ollama/tev1:0.8b"): void => {
		writeConfig(
			`models:\n  - id: switchback/auto\n    name: Auto (Switchback)\n    fallbacks: ["zai/glm-5.3"]\n    decisionModel: ${address}\ndecisionModels:\n  ${address}:\n${entryLines}`,
		);
	};

	it("parses a direct endpoint (baseUrl + apiKey)", () => {
		writeDecisionConfig("    baseUrl: http://localhost:11434/v1\n    apiKey: ollama\n");
		const { config } = loadConfig();
		expect(config.models[0]?.decisionModel).toEqual({
			provider: "ollama",
			id: "tev1:0.8b",
			baseUrl: "http://localhost:11434/v1",
			apiKey: "ollama",
		});
	});

	it("accepts an entry with no connection details (catalog resolution) and warns about it", () => {
		writeDecisionConfig("    {}\n", "typesafe/jev-latest");
		const { config, warnings } = loadConfig();
		expect(config.models[0]?.decisionModel).toEqual({ provider: "typesafe", id: "jev-latest" });
		expect(warnings.join("\n")).toMatch(/has no connection details/);
	});

	it("accepts any provider id for a direct endpoint (no reserved list in the loader)", () => {
		// The loader names no providers: whether an id collides with one pi already
		// serves is registry knowledge, and the wizard refuses that case at the
		// point where the registry is available (see classifier-catalog.ts).
		writeDecisionConfig("    baseUrl: http://localhost:11434/v1\n    apiKey: local\n", "anything/tev1:0.8b");
		const decisionModel = findModelConfig(loadConfig().config, "switchback/auto")?.decisionModel;
		expect(decisionModel?.provider).toBe("anything");
		expect(decisionModel?.baseUrl).toBe("http://localhost:11434/v1");
	});

	it("warns about the retired api field instead of accepting it", () => {
		writeDecisionConfig("    baseUrl: http://localhost:1/v1\n    apiKey: local\n    api: openai-completions\n");
		const { warnings } = loadConfig();
		expect(warnings.join("\n")).toMatch(/api is no longer supported/);
	});

	it("rejects a direct endpoint without an apiKey", () => {
		writeDecisionConfig("    baseUrl: http://localhost:11434/v1\n");
		expect(() => loadConfig()).toThrow(/apiKey is required with baseUrl/);
	});

	it("rejects apiKey without baseUrl", () => {
		writeDecisionConfig("    apiKey: secret\n");
		expect(() => loadConfig()).toThrow(/apiKey requires/);
	});

	it("rejects a non-http(s) baseUrl", () => {
		writeDecisionConfig("    baseUrl: ftp://localhost/v1\n    apiKey: local\n");
		expect(() => loadConfig()).toThrow(/must be http\(s\)/);
	});
});

describe("groupLocalEndpoints", () => {
	it("groups every model that shares an endpoint into one registration", () => {
		// pi replaces a provider's model list wholesale when an extension supplies
		// one, so every classifier on the endpoint has to travel in a single call -
		// a model left out is invisible to `findOfType` and classifies as
		// `unresolvable`.
		const groups = groupLocalEndpoints([
			{ provider: "ollama", id: "tinyjev", baseUrl: "http://localhost:11434/v1" },
			{ provider: "ollama", id: "tev1:0.8b", baseUrl: "http://localhost:11434/v1", apiKey: "token" },
		]);
		expect(groups).toHaveLength(1);
		expect(groups[0]?.provider).toBe("ollama");
		expect(groups[0]?.models.map((m) => m.id)).toEqual(["tinyjev", "tev1:0.8b"]);
		// The first non-empty key on the endpoint wins; the transport needs one.
		expect(groups[0]?.apiKey).toBe("token");
	});

	it("falls back to the provider id as the bearer token", () => {
		const [group] = groupLocalEndpoints([
			{ provider: "ollama", id: "tinyjev", baseUrl: "http://localhost:11434/v1" },
		]);
		expect(group?.apiKey).toBe("ollama");
	});

	it("keeps distinct endpoints apart and de-duplicates repeated model ids", () => {
		const groups = groupLocalEndpoints([
			{ provider: "ollama", id: "a", baseUrl: "http://localhost:11434/v1" },
			{ provider: "ollama", id: "a", baseUrl: "http://localhost:11434/v1" },
			{ provider: "ollama", id: "b", baseUrl: "http://other:11434/v1" },
		]);
		expect(groups.map((g) => `${g.provider}|${g.baseUrl}`)).toEqual([
			"ollama|http://localhost:11434/v1",
			"ollama|http://other:11434/v1",
		]);
		expect(groups[0]?.models.map((m) => m.id)).toEqual(["a"]);
	});

	it("skips catalog classifiers: a jev without a baseUrl is not switchback's to register", () => {
		expect(
			groupLocalEndpoints([
				{ provider: "typesafe", id: "jev-latest" },
				{ provider: "ollama", id: "tev1:0.8b", baseUrl: "http://localhost:11434/v1" },
			]),
		).toHaveLength(1);
		expect(groupLocalEndpoints([])).toEqual([]);
	});
});

describe("registerLocalClassifier", () => {
	interface Captured {
		id: string;
		cfg: {
			baseUrl?: string;
			apiKey?: string;
			models?: { type?: string; id: string }[];
			classifiers?: Record<string, unknown>;
		};
	}

	function capture() {
		const captured: Captured[] = [];
		return { captured, pi: { registerProvider: (id: string, cfg: never) => captured.push({ id, cfg }) } as never };
	}

	it("registers every model on the endpoint plus the transport in one call", () => {
		const { captured, pi } = capture();
		registerLocalClassifier(pi, {
			provider: "ollama",
			baseUrl: "http://localhost:11434/v1",
			apiKey: "ollama",
			models: [
				{ provider: "ollama", id: "tinyjev", baseUrl: "http://localhost:11434/v1" },
				{ provider: "ollama", id: "tev1:0.8b", baseUrl: "http://localhost:11434/v1" },
			],
		});
		expect(captured).toHaveLength(1);
		expect(captured[0]?.id).toBe("ollama");
		expect(captured[0]?.cfg.baseUrl).toBe("http://localhost:11434/v1");
		expect(captured[0]?.cfg.apiKey).toBe("ollama");
		expect(captured[0]?.cfg.models?.map((m) => m.id)).toEqual(["tinyjev", "tev1:0.8b"]);
		expect(captured[0]?.cfg.models?.every((m) => m.type === "classifier")).toBe(true);
		expect(Object.keys(captured[0]?.cfg.classifiers ?? {})).toEqual(["typesafe-system-one"]);
	});
});
