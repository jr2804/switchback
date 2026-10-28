/**
 * Tests for `/switchback-config` on the OpenCode adapter
 * (`packages/opencode/src/config-command.ts`).
 *
 * This is the argument-driven trunk of the config editor: one server-side
 * command whose argument is the edit, so every OpenCode client (TUI, desktop,
 * web, headless `opencode run`) reaches the same rules. The TUI and GUI skins
 * are expected to assemble exactly these argument strings, so the grammar
 * tested here is the contract they build on.
 *
 * Hermetic: PI_CODING_AGENT_DIR and cwd both move into a temp dir
 * (crashes.test.ts / dialogue.test.ts pattern), so the global and project
 * layers resolve inside the sandbox and the repository's own `.pi/` is never
 * touched. USERPROFILE redirection covers the Windows `~/.config` basis.
 *
 * The suite drives the executor directly - no host context, no plugin setup -
 * which is the whole point of the module's structural `ConfigCommandSink`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	clearConfigSessions,
	execute,
	layerForSession,
	parseConfigCommand,
	runConfigCommand,
	setLayerForSession,
} from "../packages/opencode/src/config-command.ts";
import { globalConfigPath, loadConfig, projectConfigPath, validateFileConfig } from "switchback-core";
import { parseDocument } from "yaml";

let tmpDir: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalUserProfile: string | undefined;

beforeEach(() => {
	originalCwd = process.cwd();
	originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
	originalUserProfile = process.env["USERPROFILE"];
	tmpDir = join(tmpdir(), `switchback-config-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env["PI_CODING_AGENT_DIR"] = join(tmpDir, "agent");
	process.env["USERPROFILE"] = join(tmpDir, "home");
	mkdirSync(join(tmpDir, "agent"), { recursive: true });
	mkdirSync(join(tmpDir, "home"), { recursive: true });
	process.chdir(tmpDir);
	clearConfigSessions();
});

afterEach(() => {
	process.chdir(originalCwd);
	if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
	if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
	else process.env["USERPROFILE"] = originalUserProfile;
	clearConfigSessions();
	rmSync(tmpDir, { recursive: true, force: true });
});

const session = "ses_test";

/** Run one command and return the report text. */
function run(argument: string): string {
	return execute(session, parseConfigCommand(argument)).text;
}

/** The layer file's parsed YAML, for assertions about what actually landed on disk. */
function layerYaml(layer: "global" | "project" = "global"): Record<string, unknown> {
	const path = layer === "global" ? globalConfigPath() : projectConfigPath();
	return parseDocument(readFileSync(path, "utf8")).toJSON() as Record<string, unknown>;
}

/** Seed the global layer with one valid model. */
function seedGlobal(): void {
	writeFileSync(
		globalConfigPath(),
		[
			"models:",
			"  - id: switchback/auto",
			"    name: Auto",
			"    fallbacks:",
			"      - zai/glm-5.3-flash",
			"      - openrouter/qwen3.8-max",
			"",
		].join("\n"),
		"utf8",
	);
	mkdirSync(join(process.env["PI_CODING_AGENT_DIR"] ?? "", ".."), { recursive: true });
}

describe("parseConfigCommand", () => {
	it("treats a bare invocation as the config report", () => {
		expect(parseConfigCommand("")).toEqual({ verb: undefined, args: [] });
		expect(parseConfigCommand(undefined)).toEqual({ verb: undefined, args: [] });
		expect(parseConfigCommand("   ")).toEqual({ verb: undefined, args: [] });
	});

	it("maps help and ? to the report with a help marker", () => {
		expect(parseConfigCommand("help")).toEqual({ verb: "show", args: ["help"] });
		expect(parseConfigCommand("?")).toEqual({ verb: "show", args: ["help"] });
	});

	it("reads a known verb and its arguments", () => {
		expect(parseConfigCommand("chain-add auto zai/glm-5.3-flash")).toEqual({
			verb: "chain-add",
			args: ["auto", "zai/glm-5.3-flash"],
		});
	});

	it("treats an unknown first word as a filter, never an error", () => {
		// `/switchback-config auto` is the shortest useful thing to type and
		// cannot be mistaken for a mutation.
		expect(parseConfigCommand("auto")).toEqual({ verb: "show", args: ["auto"] });
		expect(parseConfigCommand("nosuchverb x")).toEqual({ verb: "show", args: ["nosuchverb", "x"] });
	});

	it("collapses whitespace between arguments", () => {
		expect(parseConfigCommand("  name   auto   My  Auto  ")).toEqual({
			verb: "name",
			args: ["auto", "My", "Auto"],
		});
	});
});

describe("/switchback-config: reporting", () => {
	it("reports an empty config with the layer it would edit", () => {
		const text = run("");
		expect(text).toContain("no configuration yet");
		expect(text).toContain(globalConfigPath());
	});

	it("reports each layer file, marking the one being edited", () => {
		seedGlobal();
		setLayerForSession(session, "global");
		const text = run("layers");
		expect(text).toContain(`global (editing): ${globalConfigPath()}`);
		expect(text).toContain("1 model");
		expect(text).toContain("project:");
		expect(text).toContain("not present");
	});

	it("shows the ordered fallbacks and per-model options", () => {
		seedGlobal();
		const text = run("show");
		expect(text).toContain("switchback/auto - Auto");
		expect(text).toContain("1. zai/glm-5.3-flash");
		expect(text).toContain("2. openrouter/qwen3.8-max");
		expect(text).toContain("decision-model: (none - blind cycle)");
	});

	it("filters the report by id substring, case-insensitively", () => {
		seedGlobal();
		expect(run("auto")).toContain("switchback/auto");
		expect(run("AUTO")).toContain("switchback/auto");
		expect(run("nosuchmodel")).toContain('no configured model matches "nosuchmodel"');
	});
});

describe("/switchback-config: layers", () => {
	it("defaults to the global layer when no layer file exists", () => {
		expect(layerForSession(session)).toBe("global");
	});

	it("pins the edited layer per session", () => {
		expect(run("layer project")).toContain("editing the project layer");
		expect(layerForSession(session)).toBe("project");
		// A different session keeps its own choice.
		expect(layerForSession("ses_other")).toBe("global");
	});

	it("rejects an unknown layer name", () => {
		const text = run("layer sideways");
		expect(text).toContain("usage: /switchback-config layer <global|project>");
		expect(layerForSession(session)).toBe("global");
	});
});

describe("/switchback-config: model lifecycle", () => {
	it("adds a model with a fallback list and saves it", () => {
		const text = run("add auto Auto zai/glm-5.3-flash,openrouter/qwen3.8-max");
		expect(text).toContain("added auto");
		const config = validateFileConfig(layerYaml(), globalConfigPath()).config;
		expect(config.models).toHaveLength(1);
		expect(config.models[0]?.id).toBe("switchback/auto");
		expect(config.models[0]?.name).toBe("Auto");
		expect(config.models[0]?.fallbacks).toEqual(["zai/glm-5.3-flash", "openrouter/qwen3.8-max"]);
	});

	it("accepts a space-separated fallback list too", () => {
		run("add auto Auto zai/glm-5.3-flash openrouter/qwen3.8-max");
		const config = validateFileConfig(layerYaml(), globalConfigPath()).config;
		expect(config.models[0]?.fallbacks).toEqual(["zai/glm-5.3-flash", "openrouter/qwen3.8-max"]);
	});

	it("rejects a malformed fallback address and writes nothing", () => {
		const text = run("add auto Auto not-an-address");
		expect(text).toContain('"not-an-address" is not a "provider/model" address');
		expect(existsSync(globalConfigPath())).toBe(false);
	});

	it("reports usage when arguments are missing", () => {
		expect(run("add auto")).toContain("usage: /switchback-config add <id> <display name> <fallbacks>");
		expect(run("remove")).toContain("usage: /switchback-config remove <id>");
	});

	it("renames a model and changes its display name", () => {
		seedGlobal();
		expect(run("rename auto auto-fast")).toContain("renamed auto to auto-fast");
		expect(run("name auto-fast Fast Auto")).toContain('displayed as "Fast Auto"');
		const config = validateFileConfig(layerYaml(), globalConfigPath()).config;
		expect(config.models[0]?.id).toBe("switchback/auto-fast");
		expect(config.models[0]?.name).toBe("Fast Auto");
	});

	it("removes a model", () => {
		seedGlobal();
		run("add spare Spare zai/glm-5.3-flash");
		expect(run("remove auto")).toContain("removed auto");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models).toHaveLength(1);
	});

	it("refuses to remove the last virtual model", () => {
		seedGlobal();
		const text = run("remove auto");
		expect(text).toContain("the last virtual model cannot be removed");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models).toHaveLength(1);
	});

	it("surfaces the editor's own message for an unknown model id", () => {
		seedGlobal();
		expect(run("remove nosuchmodel")).toContain('no config entry for virtual model "switchback/nosuchmodel"');
	});
});

describe("/switchback-config: fallback order", () => {
	beforeEach(() => {
		seedGlobal();
	});

	it("replaces the whole ordered list", () => {
		expect(run("chain auto a/one,b/two")).toContain("a/one -> b/two");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models[0]?.fallbacks).toEqual([
			"a/one",
			"b/two",
		]);
	});

	it("appends one fallback", () => {
		expect(run("chain-add auto c/three")).toContain("added c/three to auto");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models[0]?.fallbacks).toEqual([
			"zai/glm-5.3-flash",
			"openrouter/qwen3.8-max",
			"c/three",
		]);
	});

	it("removes a fallback by its 1-based position", () => {
		expect(run("chain-remove auto 1")).toContain("removed fallback 1");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models[0]?.fallbacks).toEqual([
			"openrouter/qwen3.8-max",
		]);
	});

	it("moves a fallback between 1-based positions", () => {
		expect(run("chain-move auto 1 2")).toContain("moved fallback 1 to position 2");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models[0]?.fallbacks).toEqual([
			"openrouter/qwen3.8-max",
			"zai/glm-5.3-flash",
		]);
	});

	it("rejects a position below 1 and leaves the file alone", () => {
		expect(run("chain-remove auto 0")).toContain("usage: /switchback-config chain-remove <id> <n>");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models[0]?.fallbacks).toHaveLength(2);
	});
});

describe("/switchback-config: per-model options", () => {
	beforeEach(() => {
		seedGlobal();
	});

	it("sets and reports the idle-reset option", () => {
		expect(run("idle-reset auto 2h")).toContain("idle-reset is 2h");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models[0]?.idleReset).toBe("2h");
		expect(run("show")).toContain("idle-reset: 2h");
	});

	it("rejects an unknown idle-reset value and lists the options", () => {
		const text = run("idle-reset auto 3d");
		expect(text).toContain('"3d" is not an idle-reset option');
		expect(text).toContain("never, 30m, 1h, 2h, 3h, 5h, 12h, 24h, classifier");
	});

	it("sets a decision model and clears it with off", () => {
		expect(run("decision-model auto zai/glm-5.3-flash")).toContain("decision model is zai/glm-5.3-flash");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models[0]?.decisionModel).toBe(
			"zai/glm-5.3-flash",
		);
		expect(run("decision-model auto off")).toContain("decision model is off");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.models[0]?.decisionModel).toBeUndefined();
	});

	it("toggles the shared debug flag at the top level", () => {
		expect(run("debug on")).toContain("debug on");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.debug).toBe(true);
		expect(run("show")).toContain("debug: on");
		expect(run("debug off")).toContain("debug off");
		expect(validateFileConfig(layerYaml(), globalConfigPath()).config.debug).toBeFalsy();
	});

	it("rejects a debug value that is neither on nor off", () => {
		expect(run("debug maybe")).toContain("usage: /switchback-config debug <on|off>");
	});
});

describe("/switchback-config: reset", () => {
	it("removes the edited layer file", () => {
		seedGlobal();
		expect(existsSync(globalConfigPath())).toBe(true);
		expect(run("reset")).toContain("removed the global layer");
		expect(existsSync(globalConfigPath())).toBe(false);
	});

	it("reports a missing layer as already absent", () => {
		expect(run("reset")).toContain("does not exist");
	});

	it("refuses to delete a layer it cannot parse", () => {
		writeFileSync(globalConfigPath(), "models: [ not valid\n", "utf8");
		const text = run("reset");
		expect(text).toContain("was left in place");
		expect(existsSync(globalConfigPath())).toBe(true);
	});
});

describe("/switchback-config: failure handling", () => {
	it("reports an invalid saved state with the loader's own message", () => {
		// A duplicate id is structurally undetectable at add time only when the
		// file was hand-edited; the save gate still catches it.
		writeFileSync(
			globalConfigPath(),
			[
				"models:",
				"  - id: switchback/auto",
				"    name: Auto",
				"    fallbacks: [zai/glm-5.3-flash]",
				"  - id: switchback/auto",
				"    name: Duplicate",
				"    fallbacks: [zai/glm-5.3-flash]",
				"",
			].join("\n"),
			"utf8",
		);
		const text = run("debug on");
		expect(text).toContain("switchback/auto");
		expect(text).toContain("more than once");
	});

	it("reports an unreadable layer instead of editing it", () => {
		writeFileSync(globalConfigPath(), "models: [ not valid\n", "utf8");
		const text = run("add auto Auto zai/glm-5.3-flash");
		expect(text).toContain("cannot edit the global layer");
	});

	it("keeps the on-disk file loadable by the real loader after every verb", () => {
		run("add auto Auto zai/glm-5.3-flash");
		run("chain-add auto openrouter/qwen3.8-max");
		run("idle-reset auto 1h");
		run("decision-model auto zai/glm-5.3-flash");
		run("debug on");
		const loaded = loadConfig({ get: () => undefined });
		expect(loaded.config.models).toHaveLength(1);
		expect(loaded.config.models[0]?.fallbacks).toEqual(["zai/glm-5.3-flash", "openrouter/qwen3.8-max"]);
		expect(loaded.config.models[0]?.idleReset).toBe("1h");
		expect(loaded.config.debug).toBe(true);
	});
});

describe("/switchback-config: sink", () => {
	it("delivers the report through the sink and returns it", async () => {
		seedGlobal();
		const said: string[] = [];
		const result = await runConfigCommand(session, "show", {
			say: (text) => {
				said.push(text);
			},
		});
		expect(result.ok).toBe(true);
		expect(said).toEqual([result.text]);
		expect(result.text).toContain("switchback/auto");
	});

	it("returns ok:false for a rejected edit but still reports it", async () => {
		const said: string[] = [];
		const result = await runConfigCommand(session, "chain-remove auto 9", {
			say: (text) => {
				said.push(text);
			},
		});
		expect(result.ok).toBe(false);
		expect(said).toHaveLength(1);
	});
});
