/**
 * Tests for the interactive config editor: src/config-editor.ts (comment-
 * preserving YAML round-trip over one switchback.yaml layer) and
 * src/dialogue.ts (the /switchback-config flow on pi's built-in dialogs).
 *
 * The editor must carry no rules of its own: mutations are structural, and
 * saveLayer() re-validates through the loader's exported gate
 * (validateFileConfig + resolveJevConfig). Several tests therefore assert
 * that an invalid edit throws the LOADER's message at save time, and that
 * the file on disk stays untouched.
 *
 * Secret material is asserted absent from the written file, never printed:
 * the dialogue stores the value in a fake store and the config only ever
 * carries `secret:<name>` (tests/AGENTS.md rule).
 *
 * Hermetic: every test runs against a temp PI_CODING_AGENT_DIR AND a temp
 * cwd (crashes.test.ts pattern), so neither the real agent dir nor the
 * repository's own .pi/ can be touched. The temp cwd also makes the
 * project-vs-global layer default deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	addDecisionModel,
	addFallback,
	addVirtualModel,
	defaultLayer,
	loadLayer,
	moveFallback,
	readLayerConfig,
	removeDecisionModel,
	removeFallback,
	renameDecisionModel,
	renameVirtualModel,
	saveLayer,
	setDecisionModel,
	setDebug,
	type LoadedLayer,
} from "../src/config-editor.ts";
import { describeJev, layerOptionLabel, runDialogue, secretNameFor, type DialogueContext, type DialogueUi } from "../src/dialogue.ts";
import type { ClassifierProviderOption } from "../src/classifier-catalog.ts";
import type { ProbeResult } from "../src/classifier-probe.ts";
import type { JevConfig } from "../src/types.ts";
import { ConfigError } from "../src/config.ts";
import type { SecretStore } from "../src/secrets.ts";

/** A hand-annotated config with comments, a bare id, a decision-model ref and a debug flag. */
const SAMPLE = `# my custom header comment
models:
  # primary router
  - id: auto            # bare id, stays bare in the file
    name: Auto
    fallbacks:
      - zai/glm-5.3     # first choice
      - minimax/MiniMax-M3
    jev:
      decisionModel: local
decisionModels:
  # local ollama classifier
  - name: local
    provider: ollama
    id: tev1
    baseUrl: http://localhost:11434/v1
    api: typesafe-system-one
debug: false
`;

/** SAMPLE with a second model so one can be removed without emptying the file. */
const TWO_MODELS = SAMPLE.replace("decisionModels:", `  - id: switchback/alt
    name: Alt
    fallbacks:
      - ollama-cloud/m1
decisionModels:`);

/** Invalid YAML (unclosed flow sequence) for the loadLayer error path. */
const BROKEN_YAML = "models: [unclosed\n";

/** Rule-violating but parseable YAML (empty fallbacks) for the readLayerConfig error path. */
const INVALID_RULES = `models:
  - id: switchback/auto
    name: Auto
    fallbacks: []
`;

let tmpDir: string;
let originalCwd: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
	originalCwd = process.cwd();
	originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
	tmpDir = mkdtemp();
	process.env["PI_CODING_AGENT_DIR"] = tmpDir;
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
	rmSync(tmpDir, { recursive: true, force: true });
});

function mkdtemp(): string {
	return mkdtempIn(tmpdir());
}

function mkdtempIn(parent: string): string {
	return rmTempLater(join(parent, `switchback-dialogue-${Math.random().toString(36).slice(2)}`));
}

function rmTempLater(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}

const globalPath = (): string => join(tmpDir, "switchback.yaml");
const projectPath = (): string => join(tmpDir, ".pi", "switchback.yaml");

function seed(text: string, path: string = globalPath()): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text, "utf8");
}

function readText(path: string = globalPath()): string {
	return readFileSync(path, "utf8");
}

function load(layer: "global" | "project" = "global"): LoadedLayer {
	return loadLayer(layer);
}

/** Scripted UI: queues answer the dialog calls in order; an empty queue fails the test. */
class ScriptedUi implements DialogueUi {
	readonly notifications: { message: string; type: string }[] = [];
	private readonly selectQueue: Array<string | undefined>;
	private readonly inputQueue: Array<string | undefined>;
	private readonly confirmQueue: boolean[];

	constructor(script: { select?: Array<string | undefined>; input?: Array<string | undefined>; confirm?: boolean[] } = {}) {
		this.selectQueue = [...(script.select ?? [])];
		this.inputQueue = [...(script.input ?? [])];
		this.confirmQueue = [...(script.confirm ?? [])];
	}

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.notifications.push({ message, type: type ?? "info" });
	}

	async select(_title: string, _options: string[]): Promise<string | undefined> {
		if (this.selectQueue.length === 0) throw new Error("script ran dry: unexpected select call");
		return this.selectQueue.shift();
	}

	async input(_title: string, _placeholder?: string): Promise<string | undefined> {
		if (this.inputQueue.length === 0) throw new Error("script ran dry: unexpected input call");
		return this.inputQueue.shift();
	}

	async confirm(_title: string, _message: string): Promise<boolean> {
		if (this.confirmQueue.length === 0) throw new Error("script ran dry: unexpected confirm call");
		return this.confirmQueue.shift() ?? false;
	}
}

/** In-memory stand-in for the encrypted store; records set() calls for assertions. */
class FakeSecretStore implements SecretStore {
	readonly setCalls: { name: string; value: string }[] = [];
	private readonly entries = new Map<string, string>();

	set(name: string, value: string): void {
		this.setCalls.push({ name, value });
		this.entries.set(name, value);
	}
	get(name: string): string | undefined {
		return this.entries.get(name);
	}
	delete(name: string): void {
		this.entries.delete(name);
	}
	list(): string[] {
		return [...this.entries.keys()];
	}
}

function run(ui: ScriptedUi, store?: SecretStore, extra: Partial<DialogueContext> = {}): Promise<void> {
	const ctx: DialogueContext = { hasUI: true, ui, ...extra };
	return runDialogue(ctx, store);
}

const MODEL_LABEL = "switchback/auto - Auto";

describe("config-editor: layer handling", () => {
	it("creates a fresh layer file with the header comment and a normalized bare id", () => {
		const loaded = load();
		expect(loaded.existed).toBe(false);
		addVirtualModel(loaded, { id: "auto", name: "Auto", fallbacks: ["zai/glm-5.3"] });
		saveLayer(loaded);
		const text = readText();
		expect(text).toContain("switchback configuration - see docs/configuration.md");
		expect(text).toContain("id: switchback/auto");
		expect(text).toContain("zai/glm-5.3");
		expect(existsSync(`${globalPath()}.tmp`)).toBe(false);
	});

	it("prefers the global layer, falling back to a project-only file", () => {
		// Neither file exists: the global config is the natural home for a new one.
		expect(defaultLayer()).toBe("global");
		// A `.pi/` directory alone does NOT make the project layer the target - that
		// rule silently wrote project overrides for users editing their global config.
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		expect(defaultLayer()).toBe("global");
		// Only a project file exists: that is plainly what the user works with.
		seed(SAMPLE, projectPath());
		expect(defaultLayer()).toBe("project");
		// Both exist: global is the base every project inherits, so it wins.
		seed(SAMPLE);
		expect(defaultLayer()).toBe("global");
		expect(load("project").path).toBe(projectPath());
	});

	it("labels each layer with its presence, model count or invalidity", () => {
		expect(layerOptionLabel("global")).toBe("Global - not present");
		expect(layerOptionLabel("project")).toBe("Project - not present");
		seed(SAMPLE);
		expect(layerOptionLabel("global")).toBe("Global - 1 model");
		seed(TWO_MODELS, projectPath());
		expect(layerOptionLabel("project")).toBe("Project - 2 models");
		seed(BROKEN_YAML);
		expect(layerOptionLabel("global")).toBe("Global - unreadable (invalid config)");
	});
});

describe("config-editor: comment-preserving round-trip", () => {
	it("keeps comments and reorders fallbacks without touching unrelated text", () => {
		seed(SAMPLE);
		const loaded = load();
		moveFallback(loaded, "switchback/auto", 0, 1);
		saveLayer(loaded);
		const text = readText();
		expect(text).toContain("# my custom header comment");
		expect(text).toContain("# primary router");
		expect(text).toContain("# local ollama classifier");
		expect(text).toContain("# bare id, stays bare in the file");
		const config = readLayerConfig(load());
		expect(config.models[0]?.fallbacks).toEqual(["minimax/MiniMax-M3", "zai/glm-5.3"]);
		// The ref form survives: bare id stays bare, decisionModel reference intact.
		expect(text).toContain("id: auto");
		expect(config.models[0]?.jev).toEqual({ decisionModel: "local" });
	});

	it("finds a model stored under a bare id by its normalized form", () => {
		seed(SAMPLE);
		const loaded = load();
		renameVirtualModel(loaded, "switchback/auto", "switchback/auto-fast");
		saveLayer(loaded);
		expect(readText()).toContain("switchback/auto-fast");
	});

	it("rejects duplicate model ids (normalized both sides)", () => {
		seed(SAMPLE);
		const loaded = load();
		expect(() => addVirtualModel(loaded, { id: "auto", name: "Dup", fallbacks: ["a/b"] })).toThrow(ConfigError);
		expect(() => addVirtualModel(loaded, { id: "switchback/auto", name: "Dup", fallbacks: ["a/b"] })).toThrow(
			/more than once/,
		);
	});

	it("bounds-checks fallback moves and removals", () => {
		seed(SAMPLE);
		const loaded = load();
		expect(() => moveFallback(loaded, "switchback/auto", -1, 0)).toThrow(ConfigError);
		expect(() => moveFallback(loaded, "switchback/auto", 0, 5)).toThrow(ConfigError);
		expect(() => removeFallback(loaded, "switchback/auto", 9)).toThrow(ConfigError);
	});
});

describe("config-editor: the loader's gate owns every rule", () => {
	it("rejects a fallback without provider/id at save time, loader message", () => {
		seed(SAMPLE);
		const loaded = load();
		addFallback(loaded, "switchback/auto", "noprovider");
		expect(() => saveLayer(loaded)).toThrow(/provider\/id/);
		// The file on disk is untouched by the failed save.
		expect(readText()).not.toContain("noprovider");
	});

	it("rejects a dangling decisionModel reference at save time via resolveJevConfig", () => {
		seed(SAMPLE);
		const loaded = load();
		setDecisionModel(loaded, "switchback/auto", { decisionModel: "missing" });
		expect(() => saveLayer(loaded)).toThrow(/not referenced by any model\.jev\.decisionModel|is not defined in decisionModels/);
	});

	it("rejects removing a still-referenced decision model at save time", () => {
		seed(SAMPLE);
		const loaded = load();
		removeDecisionModel(loaded, "local");
		expect(() => saveLayer(loaded)).toThrow(/not referenced by any model\.jev\.decisionModel|is not defined in decisionModels/);
	});

	it("reads an invalid file through the loader's message and refuses to open it", () => {
		seed(BROKEN_YAML);
		expect(() => loadLayer("global")).toThrow(/not valid YAML/);
		seed(INVALID_RULES);
		expect(() => readLayerConfig(load())).toThrow(/fallbacks must be a non-empty array/);
	});
});

describe("config-editor: decision models and debug", () => {
	it("writes an apiKey only as a secret:<name> reference", () => {
		seed(SAMPLE);
		const loaded = load();
		addDecisionModel(loaded, {
			name: "k2",
			provider: "ollama",
			id: "tev2",
			baseUrl: "http://localhost:11434/v1",
			api: "typesafe-system-one",
			apiKeySecretName: "svc-key",
		});
		saveLayer(loaded);
		const text = readText();
		expect(text).toContain("secret:svc-key");
	});

	it("renaming a decision model rewrites the references in the same transaction", () => {
		seed(SAMPLE);
		const loaded = load();
		renameDecisionModel(loaded, "local", "renamed");
		saveLayer(loaded);
		const config = readLayerConfig(load());
		expect(config.decisionModels?.[0]?.name).toBe("renamed");
		expect(config.models[0]?.jev).toEqual({ decisionModel: "renamed" });
	});

	it("toggles the debug flag", () => {
		seed(SAMPLE);
		const loaded = load();
		setDebug(loaded, true);
		saveLayer(loaded);
		expect(readLayerConfig(load()).debug).toBe(true);
		const again = load();
		setDebug(again, false);
		saveLayer(again);
		expect(readLayerConfig(load()).debug).toBe(false);
	});
});

describe("dialogue", () => {
	it("refuses to run without a UI-capable context", async () => {
		seed(SAMPLE);
		const ui = new ScriptedUi();
		await runDialogue({ hasUI: false, ui }, new FakeSecretStore());
		expect(ui.notifications).toHaveLength(1);
		expect(ui.notifications[0]?.type).toBe("warning");
	});

	it("walks the add-virtual-model wizard into a saved file", async () => {
		const ui = new ScriptedUi({
			select: [layerOptionLabel("global"), "Add virtual model...", "Add fallback...", "Done (needs at least one)", "Done"],
			input: ["auto", "Auto (fast)", "zai/glm-5.3"],
		});
		await run(ui);
		const text = readText();
		expect(text).toContain("switchback/auto");
		expect(text).toContain("Auto (fast)");
		expect(text).toContain("zai/glm-5.3");
		expect(ui.notifications.some((n) => n.message.includes("added"))).toBe(true);
	});

	it("reverts a failed wizard (duplicate id) and leaves the file unchanged", async () => {
		seed(SAMPLE);
		const ui = new ScriptedUi({
			select: [layerOptionLabel("global"), "Add virtual model...", "Add fallback...", "Done (needs at least one)", "Done"],
			input: ["auto", "Dup", "zai/glm-5.3"],
		});
		await run(ui);
		expect(ui.notifications.some((n) => n.message.includes("more than once"))).toBe(true);
		expect(readLayerConfig(load()).models).toHaveLength(1);
	});

	it("toggles debug on and back off", async () => {
		seed(SAMPLE);
		await run(
			new ScriptedUi({ select: [layerOptionLabel("global"), "Toggle debug (currently off)", "Done"] }),
		);
		expect(readLayerConfig(load()).debug).toBe(true);
		await run(
			new ScriptedUi({ select: [layerOptionLabel("global"), "Toggle debug (currently on)", "Done"] }),
		);
		expect(readLayerConfig(load()).debug).toBe(false);
	});

	it("reorders and removes fallbacks through the editor", async () => {
		seed(SAMPLE);
		await run(
			new ScriptedUi({
				select: [layerOptionLabel("global"), MODEL_LABEL, "Edit fallbacks (2)", "Move down...", "1. zai/glm-5.3", "Done", "Back", "Done"],
			}),
		);
		expect(readLayerConfig(load()).models[0]?.fallbacks).toEqual(["minimax/MiniMax-M3", "zai/glm-5.3"]);
		await run(
			new ScriptedUi({
				select: [layerOptionLabel("global"), 
					"switchback/auto - Auto",
					"Edit fallbacks (2)",
					"Remove fallback...",
					"2. zai/glm-5.3",
					"Done",
					"Back",
					"Done",
				],
			}),
		);
		expect(readLayerConfig(load()).models[0]?.fallbacks).toEqual(["minimax/MiniMax-M3"]);
	});

	it("guards the last remaining fallback", async () => {
		seed(`models:\n  - id: switchback/auto\n    name: Auto\n    fallbacks:\n      - zai/glm-5.3\n`);
		const ui = new ScriptedUi({
			select: [layerOptionLabel("global"), MODEL_LABEL, "Edit fallbacks (1)", "Remove fallback...", undefined, undefined, "Done"],
		});
		await run(ui);
		expect(ui.notifications.some((n) => n.message.includes("at least one fallback"))).toBe(true);
		expect(readLayerConfig(load()).models[0]?.fallbacks).toEqual(["zai/glm-5.3"]);
	});

	it("stores a new API key in the secret store and writes only secret:<name> to the file", async () => {
		seed(SAMPLE);
		const store = new FakeSecretStore();
		const ui = new ScriptedUi({
			select: [layerOptionLabel("global"),
				"Decision models (1)...",
				"Add decision model...",
				"New secret...",
				"Back",
				"Done",
			],
			// Wizard order (with no catalog context): provider, baseUrl, modelId,
			// apiKey value, name (LAST, prefilled).
			input: [
				"ollama",
				"http://localhost:11434/v1",
				"tev2",
				"sk-switchback-TESTVALUE-42-not-a-real-key",
				"second",
			],
		});
		await run(ui, store);
		expect(store.setCalls).toEqual([
			// The store name is derived from the decision model, never asked for.
			{ name: "second-key", value: "sk-switchback-TESTVALUE-42-not-a-real-key" },
		]);
		const text = readText();
		expect(text).toContain("secret:second-key");
		// The literal value must be absent from the config file (tests/AGENTS.md rule).
		expect(text).not.toContain("sk-switchback-TESTVALUE-42-not-a-real-key");
	});

	it("blocks deleting a decision model that is still referenced", async () => {
		seed(SAMPLE);
		const ui = new ScriptedUi({
			select: [layerOptionLabel("global"), "Decision models (1)...", "local - ollama/tev1", "Delete", undefined, undefined, "Done"],
		});
		await run(ui);
		expect(ui.notifications.some((n) => n.message.includes("still referenced"))).toBe(true);
		expect(readLayerConfig(load()).decisionModels?.[0]?.name).toBe("local");
	});

	it("removes a model after confirm and keeps it on cancel", async () => {
		seed(TWO_MODELS);
		await run(
			new ScriptedUi({
				select: [layerOptionLabel("global"), "switchback/alt - Alt", "Remove model", "Done"],
				confirm: [true],
			}),
		);
		expect(readLayerConfig(load()).models).toHaveLength(1);
		expect(readText()).not.toContain("switchback/alt");

		seed(TWO_MODELS);
		await run(
			new ScriptedUi({
				select: [layerOptionLabel("global"), "switchback/alt - Alt", "Remove model", undefined, "Done"],
				confirm: [false],
			}),
		);
		expect(readLayerConfig(load()).models).toHaveLength(2);
	});

	it("guards the last virtual model against removal", async () => {
		seed(SAMPLE);
		const ui = new ScriptedUi({
			select: [layerOptionLabel("global"), MODEL_LABEL, "Remove model", undefined, "Done"],
			confirm: [true],
		});
		await run(ui);
		expect(ui.notifications.some((n) => n.message.includes("last virtual model"))).toBe(true);
		expect(readLayerConfig(load()).models).toHaveLength(1);
	});

	it("renames a model id and warns about the restart", async () => {
		seed(SAMPLE);
		const ui = new ScriptedUi({
			select: [layerOptionLabel("global"), MODEL_LABEL, "Rename model id (pi restart required)", "Back", "Done"],
			input: ["auto-fast"],
		});
		await run(ui);
		const config = readLayerConfig(load());
		expect(config.models[0]?.id).toBe("switchback/auto-fast");
		expect(ui.notifications.some((n) => n.message.includes("restart"))).toBe(true);
	});

	it("reports an invalid config file and exits without touching it", async () => {
		seed(INVALID_RULES);
		const before = readText();
		const ui = new ScriptedUi({ select: [layerOptionLabel("global")] });
		await run(ui);
		expect(ui.notifications[0]?.type).toBe("error");
		expect(ui.notifications[0]?.message).toContain("fallbacks must be a non-empty array");
		expect(readText()).toBe(before);
	});

	it("edits the project layer when <cwd>/.pi exists", async () => {
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		const ui = new ScriptedUi({
			select: [layerOptionLabel("project"), "Add virtual model...", "Add fallback...", "Done (needs at least one)", "Done"],
			input: ["auto", "Auto (project)", "zai/glm-5.3"],
		});
		await run(ui);
		expect(existsSync(projectPath())).toBe(true);
		expect(readText(projectPath())).toContain("Auto (project)");
		expect(existsSync(globalPath())).toBe(false);
	});

	it("edits the chosen layer and leaves the other one alone", async () => {
		seed(SAMPLE);
		seed(SAMPLE, projectPath());
		await run(
			new ScriptedUi({
				select: [layerOptionLabel("project"), "Toggle debug (currently off)", "Done"],
			}),
		);
		expect(readLayerConfig(load("project")).debug).toBe(true);
		expect(readLayerConfig(load("global")).debug).toBe(false);
	});

	it("switches layer from the main menu through the chooser", async () => {
		seed(SAMPLE);
		seed(SAMPLE, projectPath());
		await run(
			new ScriptedUi({
				select: [
					layerOptionLabel("global"),
					"Switch layer...",
					layerOptionLabel("project"),
					"Toggle debug (currently off)",
					"Done",
				],
			}),
		);
		expect(readLayerConfig(load("project")).debug).toBe(true);
		expect(readLayerConfig(load("global")).debug).toBe(false);
	});

	it("touches nothing when the layer prompt is cancelled", async () => {
		await run(new ScriptedUi({ select: [undefined] }));
		expect(existsSync(globalPath())).toBe(false);
		expect(existsSync(projectPath())).toBe(false);
	});
});

describe("dialogue: catalog-assisted setup", () => {
	// A provider pi's registry reports: switchback invents neither its id, its
	// display name, its base URL nor its classifier model ids.
	const CATALOG_PROVIDER: ClassifierProviderOption = {
		provider: "typesafe",
		label: "typesafe — TypeSafe",
		displayName: "TypeSafe",
		baseUrl: "https://api.typesafe.ai/v1/",
		api: "typesafe-system-one",
		models: ["jev-1.13", "jev-latest"],
		local: false,
		chatModels: 0,
	};

	// A `score` answer is a rubric index; the probe's rubric has three levels.
	const probeResult = (ok: boolean): ProbeResult => ({
		ok,
		answers: ok ? { choice: "sunny", score: 1, noul: true } : { score: 1 },
		missing: ok ? [] : ["choice", "noul"],
		ms: 42,
	});

	it("adds a fallback through the searchable picker", async () => {
		seed(SAMPLE);
		const picked: { title: string; current: readonly string[] }[] = [];
		await run(
			new ScriptedUi({
				select: [layerOptionLabel("global"), MODEL_LABEL, "Edit fallbacks (2)", "Add fallback...", "Done", "Back", "Done"],
			}),
			undefined,
			{
				pickModel: async (title, current) => {
					picked.push({ title, current });
					return "opencode-go/mimo-v2.6-flash";
				},
			},
		);
		expect(readLayerConfig(load()).models[0]?.fallbacks).toEqual([
			"zai/glm-5.3",
			"minimax/MiniMax-M3",
			"opencode-go/mimo-v2.6-flash",
		]);
		expect(picked).toHaveLength(1);
		expect(picked[0]?.current).toEqual(["zai/glm-5.3", "minimax/MiniMax-M3"]);
	});

	it("keeps a catalog provider catalog-resolved: no baseUrl, no api, no secret", async () => {
		seed(SAMPLE);
		const store = new FakeSecretStore();
		const probed: JevConfig[] = [];
		const ui = new ScriptedUi({
			// Wizard order: provider (from the registry), baseUrl (Enter = keep pi's
			// resolution), modelId (from the provider's own classifier list), then the
			// name LAST. There is no apiKey step: pi holds the credential, so
			// switchback neither asks for one nor writes a secret reference.
			select: [layerOptionLabel("global"), "Decision models (1)...", "Add decision model...", CATALOG_PROVIDER.label, "jev-latest", "Back", "Done"],
			input: ["", "dm2"],
			confirm: [true],
		});
		await run(ui, store, {
			classifierProviders: [CATALOG_PROVIDER],
			probeClassifier: async (jev) => {
				probed.push(jev);
				return probeResult(true);
			},
		});
		const entry = readLayerConfig(load()).decisionModels?.find((d) => d.name === "dm2");
		expect(entry?.provider).toBe("typesafe");
		expect(entry?.id).toBe("jev-latest");
		// pi resolves the endpoint, the wire api and the credential from its own
		// catalog (whatever /login configured), so the config carries none of them.
		expect(entry?.baseUrl).toBeUndefined();
		expect(entry?.api).toBeUndefined();
		expect(entry?.apiKey).toBeUndefined();
		expect(store.setCalls).toEqual([]);
		// The capability test runs with whatever pi resolves for the provider (there
		// is no switchback-side key to resolve), and reports the verdict.
		expect(probed).toHaveLength(1);
		expect(probed[0]?.apiKey).toBeUndefined();
		expect(ui.notifications.some((n) => n.message.includes("choice  ✓ sunny"))).toBe(true);
	});

	it("asks for provider id and base URL for an endpoint pi does not know", async () => {
		seed(SAMPLE);
		const store = new FakeSecretStore();
		// The catalog cannot list this endpoint's models, so the wizard asks the
		// server itself (Ollama's /api/tags, filtered by the decision capability).
		vi.stubGlobal("fetch", async () => ({
			ok: true,
			status: 200,
			json: async () => ({ models: [{ name: "tev1:0.8b", capabilities: ["decision", "completion"] }] }),
		}));
		try {
			const ui = new ScriptedUi({
				// provider ("Other"), provider id, baseUrl, modelId (live list),
				// apiKey action, apiKey value, name LAST.
				select: [layerOptionLabel("global"), "Decision models (1)...", "Add decision model...", "Other (type a provider id)...", "tev1:0.8b", "New secret...", "Back", "Done"],
				input: ["local-ollama", "http://localhost:11434/v1", "sk-switchback-TESTVALUE-42-not-a-real-key", "dm3"],
			});
			await run(ui, store, { classifierProviders: [CATALOG_PROVIDER] });
			const entry = readLayerConfig(load()).decisionModels?.find((d) => d.name === "dm3");
			expect(entry?.provider).toBe("local-ollama");
			expect(entry?.id).toBe("tev1:0.8b");
			expect(entry?.baseUrl).toBe("http://localhost:11434/v1");
			// switchback supports one direct wire protocol, so it is written, not asked.
			expect(entry?.api).toBe("typesafe-system-one");
			expect(entry?.apiKey).toBe(`secret:${secretNameFor("dm3")}`);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("offers the classifier model from the provider's known ids", async () => {
		seed(SAMPLE);
		await run(
			new ScriptedUi({
				// Wizard order: provider, model id (from the catalog list), apiKey
				// action "(no API key)", baseUrl (Enter = keep pi's catalog), name LAST.
				select: [layerOptionLabel("global"), "Decision models (1)...", "Add decision model...", CATALOG_PROVIDER.label, "jev-1.13", "(no API key)", "Back", "Done"],
				input: ["", "dm4"],
			}),
			undefined,
			{ classifierProviders: [CATALOG_PROVIDER] },
		);
		const entry = readLayerConfig(load()).decisionModels?.find((d) => d.name === "dm4");
		expect(entry?.id).toBe("jev-1.13");
		expect(entry?.baseUrl).toBeUndefined();
	});
});

describe("describeJev", () => {
	it("formats none, reference and inline forms", () => {
		expect(describeJev(undefined)).toBe("(none - report and cycle)");
		expect(describeJev({ decisionModel: "x" })).toBe('decision model "x"');
		expect(
			describeJev({ provider: "ollama", id: "tev1", baseUrl: "http://localhost:11434/v1" }),
		).toBe("ollama/tev1 (direct: http://localhost:11434/v1)");
	});
});
