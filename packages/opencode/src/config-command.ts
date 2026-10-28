/**
 * Argument-driven `/switchback-config`: the config editor behind every
 * OpenCode client.
 *
 * pi gets an interactive dialogue (`packages/pi/src/dialogue.ts`) because its
 * `ctx.ui` offers select/confirm/input. OpenCode's *server* plugin context has
 * no dialog API at all - only the TUI (`./tui`) and desktop/web (`./gui-*`)
 * entrypoints do. A `/switchback-config` written against those would be
 * invisible to headless `opencode run`, to scripts, and to every client we have
 * not shipped a bundle for.
 *
 * So the trunk is here instead: one server-side command whose argument is the
 * edit, and whose answer is a text report. Interactive pickers (TUI, GUI) are
 * thin skins that assemble exactly these argument strings and call the same
 * executor - one place where the config rules live, and no client is a second
 * class citizen.
 *
 * Grammar (`/switchback-config <verb> [args]`):
 *
 *   (none) | show                 the effective config, one line per model
 *   layers                        which layer file is edited, and by what rule
 *   layer <global|project>        pin the layer this session edits
 *
 *   add <id> <name> <fallbacks>   add a virtual model (fallbacks comma-separated)
 *   remove <id>                   remove a virtual model
 *   rename <id> <new-id>          change a model's id
 *   name <id> <display name>      change the display name
 *
 *   chain <id> <fallbacks>        replace the whole ordered fallback list
 *   chain-add <id> <fallback>     append one fallback
 *   chain-remove <id> <n>         remove fallback number n (1-based, as shown)
 *   chain-move <id> <from> <to>   move a fallback (1-based positions)
 *
 *   idle-reset <id> <value>       never | 30m | 1h | 2h | 3h | 5h | 12h | 24h | classifier
 *   decision-model <id> <addr|off> classify this chain's failures with <addr>
 *
 *   debug <on|off>                the shared `debug:` flag
 *   reset                         delete the edited layer file
 *
 * Every mutation goes through `switchback-core/config-editor.ts` and is saved
 * immediately, so the file on disk always holds the last good config: a save
 * failure reports the loader's own message and reloads the layer from disk,
 * reverting exactly the failed action. That is the same failure model as the pi
 * dialogue, reached by a different road.
 *
 * Nothing here imports the host. The executor takes a structural context (a
 * notice sink and the session key), so the server command, the TUI skin and the
 * GUI skin all drive it, and tests drive it without a host at all.
 */

import { existsSync, rmSync } from "node:fs";
import {
	addFallback,
	addVirtualModel,
	defaultLayer,
	layerPath,
	loadLayer,
	moveFallback,
	readLayerConfig,
	removeFallback,
	removeVirtualModel,
	renameVirtualModel,
	saveLayer,
	setDebug,
	setDecisionModel,
	setFallbacks,
	setIdleReset,
	setVirtualModelName,
	validateFileConfig,
	IDLE_RESET_OPTIONS,
	SWITCHBACK_PROVIDER,
	type ConfigLayer,
	type LoadedLayer,
} from "switchback-core";
import type { IdleResetConfig, ModelId, SwitchbackFileConfig } from "switchback-core";

/** Where a report goes. Best effort: a failed write must never break a command. */
export interface ConfigCommandSink {
	readonly say: (text: string) => void | Promise<void>;
}

/** The result of one invocation: human-readable text, plus the exit reason. */
export interface ConfigCommandResult {
	readonly ok: boolean;
	readonly text: string;
}

/** Per-session layer choice, keyed by session id; `defaultLayer()` seeds it. */
const sessionLayers = new Map<string, ConfigLayer>();

/** The layer this session edits (the `layer` verb pins it). */
export function layerForSession(sessionKey: string): ConfigLayer {
	return sessionLayers.get(sessionKey) ?? defaultLayer();
}

/** Pin the layer a session edits. */
export function setLayerForSession(sessionKey: string, layer: ConfigLayer): void {
	sessionLayers.set(sessionKey, layer);
}

/** Drop per-session state (plugin dispose, and tests). */
export function clearConfigSessions(): void {
	sessionLayers.clear();
}

/** Verbs the grammar accepts, in help order. */
export const CONFIG_VERBS = [
	"show",
	"layers",
	"layer",
	"add",
	"remove",
	"rename",
	"name",
	"chain",
	"chain-add",
	"chain-remove",
	"chain-move",
	"idle-reset",
	"decision-model",
	"debug",
	"reset",
] as const;

export type ConfigVerb = (typeof CONFIG_VERBS)[number];

/** One parsed invocation: the verb (undefined for a bare `/switchback-config`) and its positional arguments. */
export interface ParsedConfigCommand {
	readonly verb: ConfigVerb | undefined;
	readonly args: readonly string[];
}

/**
 * Split a command's argument text into a verb and its arguments.
 *
 * A bare invocation (and `help`) reports the config. An unknown first word is
 * treated as a *filter* rather than an error, so `/switchback-config auto`
 * shows just that chain - the shortest useful thing a user can type, and the
 * one that cannot be mistaken for a mutation.
 */
export function parseConfigCommand(input: string | undefined): ParsedConfigCommand {
	const parts = (input ?? "")
		.trim()
		.split(/\s+/u)
		.filter((part) => part.length > 0);
	const [head, ...rest] = parts;
	if (head === undefined) return { verb: undefined, args: [] };
	if (head === "help" || head === "?") return { verb: "show", args: ["help"] };
	const verb = (CONFIG_VERBS as readonly string[]).includes(head) ? (head as ConfigVerb) : undefined;
	return verb === undefined ? { verb: "show", args: parts } : { verb, args: rest };
}

/**
 * Run one `/switchback-config` invocation and report through `sink`.
 *
 * Errors are reported, never thrown: an invalid fallback address, an out-of-
 * range chain position and the loader's own validation message all arrive as
 * `ok: false` with the loader's text, and the layer is reloaded from disk so
 * the in-memory document matches the file that a failed save left untouched.
 */
export async function runConfigCommand(
	sessionKey: string,
	input: string | undefined,
	sink: ConfigCommandSink,
): Promise<ConfigCommandResult> {
	const parsed = parseConfigCommand(input);
	const result = execute(sessionKey, parsed);
	await sink.say(result.text);
	return result;
}

/** The synchronous core of a command; separated so tests read the result directly. */
export function execute(sessionKey: string, parsed: ParsedConfigCommand): ConfigCommandResult {
	const verb = parsed.verb;
	if (verb === undefined || verb === "show") return showConfig(sessionKey, parsed.args);
	if (verb === "layers") return describeLayers(sessionKey);
	if (verb === "layer") return pinLayer(sessionKey, parsed.args);
	if (verb === "reset") return resetLayer(sessionKey);
	try {
		return mutate(sessionKey, verb, parsed.args);
	} catch (error) {
		return { ok: false, text: errorText(error) };
	}
}

/** Every mutating verb: open the layer, edit, save, and describe what changed. */
function mutate(sessionKey: string, verb: ConfigVerb, args: readonly string[]): ConfigCommandResult {
	const opened = openLayer(sessionKey);
	if ("problem" in opened) return { ok: false, text: opened.problem };
	const loaded = opened.loaded;
	const before = safeConfig(loaded);
	const outcome = applyEdit(loaded, verb, args);
	if (outcome !== undefined) return { ok: false, text: outcome };
	saveLayer(loaded);
	const after = safeConfig(loaded);
	return { ok: true, text: `${describeChange(verb, args, before, after)}\n${loaded.path}` };
}

/**
 * Dispatch one edit onto the loaded document. Returns a problem string (and
 * leaves the document untouched) when the arguments do not fit the verb.
 */
function applyEdit(loaded: LoadedLayer, verb: ConfigVerb, args: readonly string[]): string | undefined {
	const [first, ...rest] = args;
	switch (verb) {
		case "add": {
			const [id, name] = args;
			const fallbacks = args.slice(2).join(" ");
			if (id === undefined || name === undefined || fallbacks.length === 0) {
				return usage(
					"add <id> <display name> <fallbacks>",
					'e.g. `add auto "Auto (fast)" zai/glm-5.3-flash,openrouter/qwen3.8-max`',
				);
			}
			const list = parseFallbacks(fallbacks);
			if ("problem" in list) return list.problem;
			addVirtualModel(loaded, { id, name, fallbacks: list.list });
			return undefined;
		}
		case "remove": {
			if (first === undefined) return usage("remove <id>");
			// Existence is checked first so an unknown id reports the editor's own
			// message instead of the "last model" guard.
			if (!hasVirtualModel(loaded, first)) {
				removeVirtualModel(loaded, first);
				return undefined;
			}
			// The loader requires at least one model, so removing the last one is
			// refused here (with an actionable message) rather than at save time.
			if (currentModelCount(loaded) <= 1) {
				return "switchback: the last virtual model cannot be removed - add another one first, or /switchback-config reset to remove the layer";
			}
			removeVirtualModel(loaded, first);
			return undefined;
		}
		case "rename": {
			if (first === undefined || rest[0] === undefined) return usage("rename <id> <new-id>");
			renameVirtualModel(loaded, first, rest[0]);
			return undefined;
		}
		case "name": {
			if (first === undefined) return usage("name <id> <display name>");
			const name = rest.join(" ").trim();
			if (name.length === 0) return usage("name <id> <display name>");
			setVirtualModelName(loaded, first, name);
			return undefined;
		}
		case "chain": {
			if (first === undefined || rest[0] === undefined) return usage("chain <id> <fallbacks>");
			const list = parseFallbacks(rest.join(" "));
			if ("problem" in list) return list.problem;
			setFallbacks(loaded, first, list.list);
			return undefined;
		}
		case "chain-add": {
			if (first === undefined || rest[0] === undefined) return usage("chain-add <id> <fallback>");
			const parsedAddress = parseFallback(rest[0]);
			if ("problem" in parsedAddress) return parsedAddress.problem;
			addFallback(loaded, first, parsedAddress.address);
			return undefined;
		}
		case "chain-remove": {
			const position = parsePosition(rest[0]);
			if (first === undefined || position === undefined)
				return usage("chain-remove <id> <n>", '"n" is the 1-based number `/switchback-config` shows');
			removeFallback(loaded, first, position - 1);
			return undefined;
		}
		case "chain-move": {
			const from = parsePosition(rest[0]);
			const to = parsePosition(rest[1]);
			if (first === undefined || from === undefined || to === undefined)
				return usage("chain-move <id> <from> <to>");
			moveFallback(loaded, first, from - 1, to - 1);
			return undefined;
		}
		case "idle-reset": {
			if (first === undefined || rest[0] === undefined) {
				return usage(`idle-reset <id> <${IDLE_RESET_OPTIONS.join("|")}>`);
			}
			const option = parseIdleReset(rest[0]);
			if (option === undefined) {
				return `switchback: "${rest[0]}" is not an idle-reset option; use one of: ${IDLE_RESET_OPTIONS.join(", ")}`;
			}
			setIdleReset(loaded, first, option);
			return undefined;
		}
		case "decision-model": {
			if (first === undefined || rest[0] === undefined) {
				return usage(
					"decision-model <id> <provider/model | off>",
					'"off" clears the key and the chain blind-cycles without classifying',
				);
			}
			const address = rest[0].toUpperCase() === "OFF" ? null : rest[0];
			if (address !== null) {
				const parsedAddress = parseFallback(address);
				if ("problem" in parsedAddress) return parsedAddress.problem;
			}
			setDecisionModel(loaded, first, address);
			return undefined;
		}
		case "debug": {
			const value = (first ?? "").toLowerCase();
			if (value !== "on" && value !== "off") return usage("debug <on|off>");
			setDebug(loaded, value === "on");
			return undefined;
		}
		default:
			return `switchback: "${verb}" is not a mutating verb`;
	}
}

/** The config report: one block per virtual model, plus the effective layer paths. */
function showConfig(sessionKey: string, args: readonly string[]): ConfigCommandResult {
	const filter = args[0]?.toLowerCase();
	const lines: string[] = [];
	for (const layer of ["project", "global"] as const) {
		const path = layerPath(layer);
		if (!existsSync(path)) continue;
		let config: SwitchbackFileConfig;
		try {
			config = readLayerConfig(loadLayer(layer));
		} catch (error) {
			lines.push(`${layer}: ${path}\n  unreadable - ${errorText(error)}`);
			continue;
		}
		const models = config.models.filter((model) => filter === undefined || model.id.toLowerCase().includes(filter));
		if (models.length === 0) continue;
		lines.push(`${layer}: ${path}`);
		for (const model of models) lines.push(...describeModel(model));
		if (config.debug === true) lines.push("  debug: on");
	}
	const layer = layerForSession(sessionKey);
	if (lines.length === 0) {
		return {
			ok: true,
			text:
				filter === undefined
					? `switchback: no configuration yet\nedit layer: ${layerPath(layer)}\nadd one with /switchback-config add <id> <name> <fallbacks>`
					: `switchback: no configured model matches "${filter}"`,
		};
	}
	return { ok: true, text: lines.join("\n") };
}

/** One model's block: identity, ordered fallbacks, and the two per-model options. */
function describeModel(model: SwitchbackFileConfig["models"][number]): string[] {
	const rows = [`  ${model.id} - ${model.name}`];
	model.fallbacks.forEach((fallback, index) => {
		rows.push(`    ${index + 1}. ${fallback}`);
	});
	rows.push(`    decision-model: ${model.decisionModel ?? "(none - blind cycle)"}`);
	if (model.idleReset !== undefined) rows.push(`    idle-reset: ${model.idleReset}`);
	return rows;
}

/** Which layer this session edits, and what is in each layer file. */
function describeLayers(sessionKey: string): ConfigCommandResult {
	const current = layerForSession(sessionKey);
	const rows = (["global", "project"] as const).map((layer) => {
		const path = layerPath(layer);
		const marker = layer === current ? " (editing)" : "";
		if (!existsSync(path)) return `  ${layer}${marker}: ${path}\n    not present`;
		try {
			const models = readLayerConfig(loadLayer(layer)).models.length;
			return `  ${layer}${marker}: ${path}\n    ${models} model${models === 1 ? "" : "s"}`;
		} catch (error) {
			return `  ${layer}${marker}: ${path}\n    unreadable - ${errorText(error)}`;
		}
	});
	return {
		ok: true,
		text: `switchback: config layers (project overrides global per model id)\n${rows.join("\n")}\nchange with /switchback-config layer <global|project>`,
	};
}

/** Pin the edited layer for this session. */
function pinLayer(sessionKey: string, args: readonly string[]): ConfigCommandResult {
	const target = (args[0] ?? "").toLowerCase();
	if (target !== "global" && target !== "project") {
		return { ok: false, text: usage("layer <global|project>") };
	}
	setLayerForSession(sessionKey, target);
	return { ok: true, text: `switchback: editing the ${target} layer (${layerPath(target)})` };
}

/** Delete the edited layer file, after confirming it parses (so we never delete a file we misread). */
function resetLayer(sessionKey: string): ConfigCommandResult {
	const layer = layerForSession(sessionKey);
	const path = layerPath(layer);
	if (!existsSync(path)) return { ok: true, text: `switchback: the ${layer} layer does not exist (${path})` };
	try {
		readLayerConfig(loadLayer(layer));
	} catch (error) {
		return {
			ok: false,
			text: `switchback: ${path} is not a valid config, so it was left in place; fix it by hand - ${errorText(error)}`,
		};
	}
	try {
		rmSync(path, { force: true });
	} catch (error) {
		return { ok: false, text: `switchback: cannot remove ${path} - ${errorText(error)}` };
	}
	return { ok: true, text: `switchback: removed the ${layer} layer (${path})` };
}

/** Open the layer this session edits, mapping a load failure to a report. */
function openLayer(sessionKey: string): { loaded: LoadedLayer } | { problem: string } {
	const layer = layerForSession(sessionKey);
	try {
		return { loaded: loadLayer(layer) };
	} catch (error) {
		return {
			problem: `switchback: cannot edit the ${layer} layer (${layerPath(layer)}) - ${errorText(error)}`,
		};
	}
}

/** The layer's config, or undefined when the document does not validate (an edit that is being fixed). */
function safeConfig(loaded: LoadedLayer): SwitchbackFileConfig | undefined {
	try {
		return validateFileConfig(loaded.doc.toJSON(), loaded.path).config;
	} catch {
		return undefined;
	}
}

/** Whether the layer's document names this virtual model. */
function hasVirtualModel(loaded: LoadedLayer, id: string): boolean {
	const models = loaded.doc.get("models");
	if (models === undefined || models === null) return false;
	const items = (models as { items?: readonly unknown[] }).items;
	if (!Array.isArray(items)) return false;
	const want = id.includes("/") ? id : `${SWITCHBACK_PROVIDER}/${id}`;
	return items.some((item) => {
		const value = (item as { get?: (key: string) => unknown }).get;
		const actual = typeof value === "function" ? value.call(item, "id") : undefined;
		return actual === want;
	});
}

/**
 * How many virtual models the edited document holds right now. Counts the raw
 * node list rather than the validated config, because a mid-edit document may
 * not validate yet and the count is only used for the "last model" guard.
 */
function currentModelCount(loaded: LoadedLayer): number {
	const models = loaded.doc.get("models");
	if (models === undefined || models === null) return 0;
	const items = (models as { items?: readonly unknown[] }).items;
	return Array.isArray(items) ? items.length : 0;
}

/** A one-line account of what an edit did, in the reader's vocabulary. */
function describeChange(
	verb: ConfigVerb,
	args: readonly string[],
	before: SwitchbackFileConfig | undefined,
	after: SwitchbackFileConfig | undefined,
): string {
	const id = args[0] ?? "";
	switch (verb) {
		case "add":
			return `switchback: added ${id}`;
		case "remove":
			return `switchback: removed ${id}`;
		case "rename":
			return `switchback: renamed ${id} to ${args[1] ?? ""}`;
		case "name":
			return `switchback: ${id} is now displayed as "${args.slice(1).join(" ")}"`;
		case "chain":
			return `switchback: ${id} fallbacks: ${(after?.models.find((m) => sameId(m.id, id))?.fallbacks ?? []).join(" -> ")}`;
		case "chain-add":
			return `switchback: added ${args[1] ?? ""} to ${id}`;
		case "chain-remove":
			return `switchback: removed fallback ${args[1] ?? ""} from ${id}`;
		case "chain-move":
			return `switchback: moved fallback ${args[1] ?? ""} to position ${args[2] ?? ""} in ${id}`;
		case "idle-reset":
			return `switchback: ${id} idle-reset is ${args[1] ?? ""}`;
		case "decision-model":
			return `switchback: ${id} decision model is ${args[1] ?? ""}`;
		case "debug":
			return `switchback: debug ${args[0] ?? ""}`;
		default: {
			const count = after?.models.length ?? before?.models.length ?? 0;
			return `switchback: ${verb} applied (${count} model${count === 1 ? "" : "s"} configured)`;
		}
	}
}

/** Compare ids the way the editor does: `auto` and `switchback/auto` name the same model. */
function sameId(left: string, right: string): boolean {
	const normalize = (id: string) => (id.includes("/") ? id : `switchback/${id}`);
	return normalize(left) === normalize(right);
}

/** A comma/space separated fallback list, or the problem that rejects it. */
function parseFallbacks(input: string): { list: ModelId[] } | { problem: string } {
	const parts = input
		.split(/[,\s]+/u)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
	if (parts.length === 0) return { problem: 'switchback: a fallback list needs at least one "provider/model"' };
	const list: ModelId[] = [];
	for (const part of parts) {
		const parsed = parseFallback(part);
		if ("problem" in parsed) return parsed;
		list.push(parsed.address);
	}
	return { list };
}

/**
 * One `provider/model` address, or the problem that rejects it. A tagged result
 * rather than a union: a valid address is itself a string, so an untagged
 * return cannot distinguish success from failure.
 */
function parseFallback(input: string): { address: ModelId } | { problem: string } {
	const address = input.trim();
	const slash = address.indexOf("/");
	if (slash <= 0 || slash === address.length - 1) {
		return { problem: `switchback: "${address}" is not a "provider/model" address` };
	}
	return { address };
}

/** A 1-based position as the config report numbers them. */
function parsePosition(input: string | undefined): number | undefined {
	if (input === undefined) return undefined;
	const value = Number(input);
	return Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** One of `IDLE_RESET_OPTIONS`, or undefined. */
function parseIdleReset(input: string): IdleResetConfig | undefined {
	const value = input.trim();
	return (IDLE_RESET_OPTIONS as readonly string[]).includes(value) ? (value as IdleResetConfig) : undefined;
}

/** A usage line, prefixed so every report is recognisably switchback's. */
function usage(syntax: string, note?: string): string {
	return `switchback: usage: /switchback-config ${syntax}${note === undefined ? "" : `\n  ${note}`}`;
}

/** The message of a thrown value, for ConfigError and anything else. */
function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
