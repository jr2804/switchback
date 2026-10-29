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
 * touched. USERPROFILE redirection covers the Windows `~/.config` basis and
 * SWITCHBACK_CONFIG_DIR pins the one config file into the sandbox on every
 * platform (Linux `homedir()` reads `$HOME`, which USERPROFILE cannot reach).
 *
 * The suite drives the executor directly - no host context, no plugin setup -
 * which is the whole point of the module's structural `ConfigCommandSink`.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execute, parseConfigCommand, runConfigCommand } from "../packages/opencode/src/config-command.ts";
import { configFilePath, loadConfig, validateFileConfig } from "switchback-core";
import { parseDocument } from "yaml";

let tmpDir: string;
let originalCwd: string;
let originalAgentDir: string | undefined;
let originalUserProfile: string | undefined;
let originalConfigDir: string | undefined;

beforeEach(() => {
	originalCwd = process.cwd();
	originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
	originalUserProfile = process.env["USERPROFILE"];
	originalConfigDir = process.env["SWITCHBACK_CONFIG_DIR"];
	tmpDir = join(tmpdir(), `switchback-config-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env["PI_CODING_AGENT_DIR"] = join(tmpDir, "agent");
	process.env["USERPROFILE"] = join(tmpDir, "home");
	process.env["SWITCHBACK_CONFIG_DIR"] = join(tmpDir, "config");
	mkdirSync(join(tmpDir, "agent"), { recursive: true });
	mkdirSync(join(tmpDir, "home"), { recursive: true });
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
	if (originalUserProfile === undefined) delete process.env["USERPROFILE"];
	else process.env["USERPROFILE"] = originalUserProfile;
	if (originalConfigDir === undefined) delete process.env["SWITCHBACK_CONFIG_DIR"];
	else process.env["SWITCHBACK_CONFIG_DIR"] = originalConfigDir;
	rmSync(tmpDir, { recursive: true, force: true });
});

const session = "ses_test";

/** Run one command and return the report text. */
function run(argument: string): string {
	return execute(session, parseConfigCommand(argument)).text;
}

/** The layer file's parsed YAML, for assertions about what actually landed on disk. */
function configYaml(): Record<string, unknown> {
	const path = configFilePath();
	return parseDocument(readFileSync(path, "utf8")).toJSON() as Record<string, unknown>;
}

/** Seed the global layer with one valid model. */
function seedConfig(): void {
	mkdirSync(dirname(configFilePath()), { recursive: true });
	writeFileSync(
		configFilePath(),
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
	it("reports an empty config with the file it would create", () => {
		const text = run("");
		expect(text).toContain("no configuration yet");
		expect(text).toContain(configFilePath());
	});

	it("shows the ordered fallbacks and per-model options", () => {
		seedConfig();
		const text = run("show");
		expect(text).toContain("switchback/auto - Auto");
		expect(text).toContain("1. zai/glm-5.3-flash");
		expect(text).toContain("2. openrouter/qwen3.8-max");
		expect(text).toContain("decision-model: (none - blind cycle)");
	});

	it("filters the report by id substring, case-insensitively", () => {
		seedConfig();
		expect(run("auto")).toContain("switchback/auto");
		expect(run("AUTO")).toContain("switchback/auto");
		expect(run("nosuchmodel")).toContain('no configured model matches "nosuchmodel"');
	});
});

describe("/switchback-config: model lifecycle", () => {
	it("adds a model with a fallback list and saves it", () => {
		const text = run("add auto Auto zai/glm-5.3-flash,openrouter/qwen3.8-max");
		expect(text).toContain("added auto");
		const config = validateFileConfig(configYaml(), configFilePath()).config;
		expect(config.models).toHaveLength(1);
		expect(config.models[0]?.id).toBe("switchback/auto");
		expect(config.models[0]?.name).toBe("Auto");
		expect(config.models[0]?.fallbacks).toEqual(["zai/glm-5.3-flash", "openrouter/qwen3.8-max"]);
	});

	it("accepts a space-separated fallback list too", () => {
		run("add auto Auto zai/glm-5.3-flash openrouter/qwen3.8-max");
		const config = validateFileConfig(configYaml(), configFilePath()).config;
		expect(config.models[0]?.fallbacks).toEqual(["zai/glm-5.3-flash", "openrouter/qwen3.8-max"]);
	});

	it("rejects a malformed fallback address and writes nothing", () => {
		const text = run("add auto Auto not-an-address");
		expect(text).toContain('"not-an-address" is not a "provider/model" address');
		expect(existsSync(configFilePath())).toBe(false);
	});

	it("reports usage when arguments are missing", () => {
		expect(run("add auto")).toContain("usage: /switchback-config add <id> <display name> <fallbacks>");
		expect(run("remove")).toContain("usage: /switchback-config remove <id>");
	});

	it("renames a model and changes its display name", () => {
		seedConfig();
		expect(run("rename auto auto-fast")).toContain("renamed auto to auto-fast");
		expect(run("name auto-fast Fast Auto")).toContain('displayed as "Fast Auto"');
		const config = validateFileConfig(configYaml(), configFilePath()).config;
		expect(config.models[0]?.id).toBe("switchback/auto-fast");
		expect(config.models[0]?.name).toBe("Fast Auto");
	});

	it("removes a model", () => {
		seedConfig();
		run("add spare Spare zai/glm-5.3-flash");
		expect(run("remove auto")).toContain("removed auto");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models).toHaveLength(1);
	});

	it("refuses to remove the last virtual model", () => {
		seedConfig();
		const text = run("remove auto");
		expect(text).toContain("the last virtual model cannot be removed");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models).toHaveLength(1);
	});

	it("surfaces the editor's own message for an unknown model id", () => {
		seedConfig();
		expect(run("remove nosuchmodel")).toContain('no config entry for virtual model "switchback/nosuchmodel"');
	});
});

describe("/switchback-config: fallback order", () => {
	beforeEach(() => {
		seedConfig();
	});

	it("replaces the whole ordered list", () => {
		expect(run("chain auto a/one,b/two")).toContain("a/one -> b/two");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models[0]?.fallbacks).toEqual([
			"a/one",
			"b/two",
		]);
	});

	it("appends one fallback", () => {
		expect(run("chain-add auto c/three")).toContain("added c/three to auto");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models[0]?.fallbacks).toEqual([
			"zai/glm-5.3-flash",
			"openrouter/qwen3.8-max",
			"c/three",
		]);
	});

	it("removes a fallback by its 1-based position", () => {
		expect(run("chain-remove auto 1")).toContain("removed fallback 1");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models[0]?.fallbacks).toEqual([
			"openrouter/qwen3.8-max",
		]);
	});

	it("moves a fallback between 1-based positions", () => {
		expect(run("chain-move auto 1 2")).toContain("moved fallback 1 to position 2");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models[0]?.fallbacks).toEqual([
			"openrouter/qwen3.8-max",
			"zai/glm-5.3-flash",
		]);
	});

	it("rejects a position below 1 and leaves the file alone", () => {
		expect(run("chain-remove auto 0")).toContain("usage: /switchback-config chain-remove <id> <n>");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models[0]?.fallbacks).toHaveLength(2);
	});
});

describe("/switchback-config: per-model options", () => {
	beforeEach(() => {
		seedConfig();
	});

	it("sets and reports the idle-reset option", () => {
		expect(run("idle-reset auto 2h")).toContain("idle-reset is 2h");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models[0]?.idleReset).toBe("2h");
		expect(run("show")).toContain("idle-reset: 2h");
	});

	it("rejects an unknown idle-reset value and lists the options", () => {
		const text = run("idle-reset auto 3d");
		expect(text).toContain('"3d" is not an idle-reset option');
		expect(text).toContain("never, 30m, 1h, 2h, 3h, 5h, 12h, 24h, classifier");
	});

	it("sets a decision model and clears it with off", () => {
		expect(run("decision-model auto zai/glm-5.3-flash")).toContain("decision model is zai/glm-5.3-flash");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models[0]?.decisionModel).toBe(
			"zai/glm-5.3-flash",
		);
		expect(run("decision-model auto off")).toContain("decision model is off");
		expect(validateFileConfig(configYaml(), configFilePath()).config.models[0]?.decisionModel).toBeUndefined();
	});

	it("toggles the shared debug flag at the top level", () => {
		expect(run("debug on")).toContain("debug on");
		expect(validateFileConfig(configYaml(), configFilePath()).config.debug).toBe(true);
		expect(run("show")).toContain("debug: on");
		expect(run("debug off")).toContain("debug off");
		expect(validateFileConfig(configYaml(), configFilePath()).config.debug).toBeFalsy();
	});

	it("rejects a debug value that is neither on nor off", () => {
		expect(run("debug maybe")).toContain("usage: /switchback-config debug <on|off>");
	});
});

describe("/switchback-config: reset", () => {
	it("removes the config file", () => {
		seedConfig();
		expect(existsSync(configFilePath())).toBe(true);
		expect(run("reset")).toContain("removed the config file");
		expect(existsSync(configFilePath())).toBe(false);
	});

	it("reports a missing file as already absent", () => {
		expect(run("reset")).toContain("there is no config file");
	});

	it("refuses to delete a file it cannot parse", () => {
		mkdirSync(dirname(configFilePath()), { recursive: true });
		writeFileSync(configFilePath(), "models: [ not valid\n", "utf8");
		const text = run("reset");
		expect(text).toContain("was left in place");
		expect(existsSync(configFilePath())).toBe(true);
	});
});

describe("/switchback-config: failure handling", () => {
	it("tolerates a hand-edited duplicate id: the verb lands, the loader keeps the first entry", () => {
		// A duplicate id is structurally undetectable at add time only when the
		// file was hand-edited; the loader tolerates it (first entry wins, warning
		// instead of failure), so the command no longer hard-fails either.
		mkdirSync(dirname(configFilePath()), { recursive: true });
		writeFileSync(
			configFilePath(),
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
		expect(text).not.toContain("more than once");
		expect(configYaml().debug).toBe(true);
		// First entry wins on the next load; the duplicate stays a warning.
		const { config, warnings } = loadConfig({ get: () => undefined });
		expect(config.models).toHaveLength(1);
		expect(config.models[0]?.name).toBe("Auto");
		expect(warnings.join("\n")).toMatch(/repeats the id "switchback\/auto"/);
	});

	it("reports an unreadable file instead of editing it", () => {
		mkdirSync(dirname(configFilePath()), { recursive: true });
		writeFileSync(configFilePath(), "models: [ not valid\n", "utf8");
		const text = run("add auto Auto zai/glm-5.3-flash");
		expect(text).toContain("cannot edit");
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
		seedConfig();
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
