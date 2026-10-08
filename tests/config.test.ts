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
} from "../src/config.ts";
import { groupLocalEndpoints, registerLocalClassifier } from "../src/local-classifier.ts";

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
		writeFileSync(
			join(tmpDir, ".pi", "switchback.json"),
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

describe("loadConfig - bare ids and decisionModel references", () => {
	const writeWith = (modelsYaml: string, decisionModelsYaml = ""): void => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(join(tmpDir, ".pi", "switchback.yaml"), `models:\n  ${modelsYaml}\n${decisionModelsYaml}`);
	};

	it("normalises a bare model id (auto → switchback/auto)", () => {
		writeWith(`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]`);
		const { config } = loadConfig();
		expect(config.models[0]?.id).toBe("switchback/auto");
	});

	it("resolves a decisionModel reference against the decisionModels list", () => {
		writeWith(
			`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]
    jev:
      decisionModel: main`,
			`decisionModels:
  - name: main
    provider: typesafe
    id: jev-latest
    baseUrl: http://localhost:11434/v1
    api: typesafe-system-one
    apiKey: ollama
`,
		);
		const { config } = loadConfig();
		expect(config.models[0]?.jev).toEqual({
			provider: "typesafe",
			id: "jev-latest",
			baseUrl: "http://localhost:11434/v1",
			api: "typesafe-system-one",
			apiKey: "ollama",
		});
	});

	it("rejects a decisionModel reference to an unknown name", () => {
		writeWith(`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]
    jev:
      decisionModel: does-not-exist`);
		expect(() => loadConfig()).toThrow(/decisionModel "does-not-exist"/);
	});

	it("rejects decisionModels when none of them are referenced", () => {
		writeWith(
			`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]`,
			`decisionModels:
  - name: main
    provider: typesafe
    id: jev-latest
  - name: backup
    provider: typesafe
    id: jev-1.13
`,
		);
		expect(() => loadConfig()).toThrow(/decisionModels entries are not referenced/);
	});

	it("accepts a partial reference (one referenced, others unused)", () => {
		writeWith(
			`- id: auto
    name: Main
    fallbacks: ["zai/glm-5.3"]
    jev:
      decisionModel: main`,
			`decisionModels:
  - name: main
    provider: typesafe
    id: jev-latest
  - name: backup
    provider: typesafe
    id: jev-1.13
`,
		);
		const { config } = loadConfig();
		expect(config.models[0]?.jev).toEqual({ provider: "typesafe", id: "jev-latest" });
	});
});

describe("loadConfig - debug flag", () => {
	const writeWith = (yaml: string): void => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(join(tmpDir, ".pi", "switchback.yaml"), yaml);
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
			"      provider: ollama\n      id: tev1:0.8b\n      baseUrl: http://localhost:11434/v1\n      api: typesafe-system-one\n      apiKey: ollama\n",
		);
		const { config } = loadConfig();
		expect(config.models[0]?.jev).toEqual({
			provider: "ollama",
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

	it("accepts any provider id for a direct endpoint (no reserved list in the loader)", () => {
		// The loader names no providers: whether an id collides with one pi already
		// serves is registry knowledge, and the wizard refuses that case at the
		// point where the registry is available (see classifier-catalog.ts).
		writeConfig(
			"      provider: anything\n      id: tev1:0.8b\n      baseUrl: http://localhost:11434/v1\n      api: typesafe-system-one\n      apiKey: local\n",
		);
		const jev = findModelConfig(loadConfig().config, "switchback/auto")?.jev;
		expect(jev?.provider).toBe("anything");
		expect(jev?.baseUrl).toBe("http://localhost:11434/v1");
	});

	it("rejects an unsupported api", () => {
		writeConfig(
			"      provider: x\n      id: y\n      baseUrl: http://localhost:1/v1\n      api: openai-completions\n",
		);
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
