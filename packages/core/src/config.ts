/**
 * User-facing switchback config loader.
 *
 * Config files (YAML): `~/.config/switchback/switchback.yaml` is the shared
 * base read by every host, with optional per-host overlays applied on top:
 * `switchback.pi.yaml` for pi, `switchback.oc.yaml` for OpenCode. A host that
 * passes its overlay to `loadConfig()` reads base + its own overlay merged;
 * a host that passes nothing reads the base alone. Overlays are partial files
 * (every section optional): models with an id already in the base replace
 * that entry, new ids are appended; `decisionProviders`/`decisionModels`
 * merge per key with the overlay winning; `debug` in the overlay wins when
 * present. Overlay files are optional and missing files are simply skipped.
 *
 * The location is `~/.config/switchback/` - not a host's private directory - so
 * the same config serves pi and OpenCode. Override the directory with
 * `SWITCHBACK_CONFIG_DIR` (tests, sandboxes).
 *
 * DEFAULT_CONFIG ships with `fallbacks: []` (no provider hardcoded) so a configless
 * user gets a clear, actionable error instead of a silently-broken router. The
 * fail-fast happens at extension load: `findModelConfig()` throws ConfigError
 * from index.ts (module top level) before route()/decide() ever runs. The
 * message names the known fix ("Configure fallbacks in
 * ~/.config/switchback/switchback.yaml and re-launch."). Until the user does
 * that, the extension is unavailable and `/switchback` diagnostics are not
 * registered; with `defaultModel=switchback/auto` in pi's settings.json, every
 * new session also starts with an invalid default. Trade-off accepted: prefer
 * a loud, recoverable failure to a silent one. The `config-invalid` decision
 * emitted by `decide()` covers the SEPARATE case of a non-empty list whose
 * every entry is greyed at route time.
 *
 * Note: switchback.yaml is YAML only. JSON files in this project are reserved
 * for machine-managed state (`<piConfigDir>/switchback/blocks.json`, the
 * blocked-until map) and the simulate fixture (`switchback.simulate.json`); user
 * config never goes through JSON.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { IDLE_RESET_OPTIONS } from "./idle.ts";
import type {
	DecisionModelConfig,
	DecisionModelEntry,
	DecisionModelId,
	DecisionProviderConfig,
	DecisionProviderEntry,
	ModelId,
	ResolvedSwitchbackConfig,
	ResolvedSwitchbackFileConfig,
	SwitchbackConfig,
	SwitchbackFileConfig,
	IdleResetConfig,
} from "./types.ts";

const PROVIDER = "switchback";
const VIRTUAL_ID = "auto";
const CONFIG_BASENAME = "switchback";

/** Recognised keys, per level. Anything else is reported as a warning, not an error. */
const FILE_KEYS = ["models", "decisionProviders", "decisionModels", "debug"] as const;
const MODEL_KEYS = ["id", "name", "fallbacks", "decisionModel", "idleReset"] as const;
const DECISION_MODEL_KEYS = ["baseUrl", "apiKey"] as const;

/**
 * Built-in default used when no user config is present.
 *
 * Empty by design: an empty fallback list routes to the `config-invalid`
 * decision path so the user gets a clear, actionable error instead of a
 * silently-broken router. A project-local `.pi/switchback.yaml` or the
 * agent-dir copy is what fills this in.
 */
export const DEFAULT_CONFIG: ResolvedSwitchbackFileConfig = {
	models: [
		{
			id: `${PROVIDER}/${VIRTUAL_ID}`,
			name: "Auto (Switchback)",
			fallbacks: [],
		},
	],
};

export class ConfigError extends Error {
	constructor(
		message: string,
		public readonly path: string,
	) {
		super(`switchback config error (${path}): ${message}`);
		this.name = "ConfigError";
	}
}

/**
 * Resolve the agent config directory. PI_CODING_AGENT_DIR is pi's own override
 * for testing/sandboxing; the default is `~/.pi/agent`. This is the single
 * source of truth for where switchback's runtime state lives (blocks.json,
 * crashes.json) - importing this from state.ts and crashes.ts avoids drift.
 */
export function piConfigDir(): string {
	return process.env["PI_CODING_AGENT_DIR"] ?? join(homedir(), ".pi", "agent");
}

/**
 * Resolve the neutral switchback config directory. This is the canonical,
 * agent-agnostic location for switchback user config: `~/.config/switchback`.
 * It is the only config location switchback reads.
 */
export function switchbackConfigDir(): string {
	return process.env[SWITCHBACK_CONFIG_DIR_ENV] ?? join(homedir(), ".config", "switchback");
}

/**
 * Env override naming the config directory outright. Lets tests and sandboxes pin
 * the file without touching the user's real `~/.config/switchback`.
 */
export const SWITCHBACK_CONFIG_DIR_ENV = "SWITCHBACK_CONFIG_DIR";

/** Env override naming the shared switchback state directory outright. */
export const SWITCHBACK_DIR_ENV = "SWITCHBACK_DIR";

/** Env override for the `debug:` flag: any value but 0/false/off/no enables it. */
export const SWITCHBACK_DEBUG_ENV = "SWITCHBACK_DEBUG";

/**
 * Read an environment override for the config's `debug:` flag.
 *
 * An empty or absent value means "no override" (`undefined`) so the config
 * decides; `0`/`false`/`off`/`no` (any case) disable, anything else enables.
 * Shared by both hosts: the documented `SWITCHBACK_DEBUG=1` override is a
 * property of the config surface, not of one adapter.
 */
export function debugFlag(value: string | undefined): boolean | undefined {
	const v = value?.trim().toLowerCase();
	if (v === undefined || v === "") return undefined;
	return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * The effective diagnostics switch: `SWITCHBACK_DEBUG` when it says anything,
 * otherwise the config's `debug:`, otherwise off. Both hosts resolve it here so
 * the env override cannot drift between them (pi shipped it, OpenCode silently
 * ignored it while the docs promised both).
 */
export function resolveDebug(
	configured: boolean | undefined,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return debugFlag(env[SWITCHBACK_DEBUG_ENV]) ?? configured ?? false;
}

/**
 * The shared switchback state directory: blocks.json, crashes.json,
 * pin.json, secrets.json. Runtime files live here so they are account-scoped,
 * not project-scoped: a block on `zai/glm-5.3` for hitting the 5h window is a
 * fact about the account's quota, not the project on disk.
 *
 * Both adapters resolve the same default - pi's agent dir - so a block recorded
 * under one host is honoured under the other. `SWITCHBACK_DIR` moves the whole
 * directory somewhere host-neutral.
 */
export function switchbackStateDir(): string {
	return process.env[SWITCHBACK_DIR_ENV] ?? join(piConfigDir(), "switchback");
}

/**
 * Where the user config lives. The shared base every host reads:
 * `~/.config/switchback/switchback.yaml`. Per-host overlays
 * (`configOverlayPath()`) layer on top of this file - see `loadConfig()`.
 */
export function configFilePath(): string {
	return join(switchbackConfigDir(), `${CONFIG_BASENAME}.yaml`);
}

/** Which host's overlay to apply in `loadConfig()`. */
export type SwitchbackHost = "pi" | "opencode";

/** Overlay filenames, per host. Optional partial files merged over the base. */
const OVERLAY_BASENAMES: Record<SwitchbackHost, string> = {
	pi: `${CONFIG_BASENAME}.pi`,
	opencode: `${CONFIG_BASENAME}.oc`,
};

/**
 * Where a host's overlay lives, when it has one:
 * `~/.config/switchback/switchback.pi.yaml` for pi,
 * `~/.config/switchback/switchback.oc.yaml` for OpenCode.
 * The file is optional - absence means "no overlay".
 */
export function configOverlayPath(host: SwitchbackHost): string {
	return join(switchbackConfigDir(), `${OVERLAY_BASENAMES[host]}.yaml`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a provider id: a single YAML map key that names a provider, without
 * the "/" a decision-model address has (the model id is the second half of the
 * address and never part of the provider key).
 */
function parseProviderId(value: string, where: string): string {
	if (value.length === 0) throw new ConfigError(`${where} must be a non-empty provider id`, where);
	if (value.includes("/")) {
		throw new ConfigError(
			`${where} must be a provider id (e.g. "ollama"), not a "provider/model" address - the model id belongs in models[].decisionModel`,
			where,
		);
	}
	if (/\s/u.test(value)) throw new ConfigError(`${where} must not contain whitespace`, where);
	return value;
}

function parseModelId(value: unknown, where: string): ModelId {
	if (typeof value !== "string") throw new ConfigError(`${where} must be a string (e.g. "provider/id")`, where);
	if (value.indexOf("/") <= 0) throw new ConfigError(`${where} must be of the form "provider/id"`, where);
	return value;
}

/** Keys the previous schema used. They warn with the replacement instead of a generic message. */
const RETIRED_KEYS: Record<string, string> = {
	jev: "use decisionModel: <provider>/<model-id> instead",
	api: "drop it - a decisionModels entry always speaks the SystemOne wire API",
};

/**
 * Report keys this schema does not know. Stale or misspelled keys are warnings,
 * not errors: the rest of the file still loads, and the message names the key so
 * it can be fixed without reading the source.
 */
function noteUnknownKeys(
	value: Record<string, unknown>,
	allowed: readonly string[],
	where: string,
	warnings: string[],
): void {
	for (const key of Object.keys(value)) {
		if (allowed.includes(key)) continue;
		const retired = RETIRED_KEYS[key];
		warnings.push(
			retired === undefined
				? `${where}.${key} is not a switchback config key and was ignored`
				: `${where}.${key} is no longer supported; ${retired}`,
		);
	}
}

/** A decision-model address is "provider/model-id", the same shape as a fallback. */
function parseDecisionModelId(value: unknown, where: string): DecisionModelId {
	return parseModelId(value, `${where}.decisionModel`);
}

/** Split an address on the first "/" - model ids may themselves contain ":" (e.g. tev1:0.8b). */
function splitAddress(address: DecisionModelId, where: string): { provider: string; id: string } {
	const slash = address.indexOf("/");
	if (slash <= 0 || slash === address.length - 1) {
		throw new ConfigError(`${where} must be of the form "provider/model-id"`, where);
	}
	return { provider: address.slice(0, slash), id: address.slice(slash + 1) };
}

/**
 * Validate one connection-details map value. `baseUrl` and `apiKey` come as a
 * pair: a direct endpoint needs a bearer token even when the endpoint ignores it
 * (`apiKey: local`), and a token without an endpoint would be dead weight.
 *
 * No warning is emitted when both are absent: the address then resolves through
 * the host's classifier catalog, which is a perfectly valid configuration (pi
 * does exactly that). Whether that is a problem is a *host* question - pi has a
 * catalog, OpenCode does not - so it is answered where the host knows, not here.
 */
function parseConnectionEntry(rawEntry: unknown, where: string, path: string, warnings: string[]): DecisionModelEntry {
	if (!isRecord(rawEntry)) throw new ConfigError(`${where} must be an object with baseUrl and apiKey`, path);
	noteUnknownKeys(rawEntry, DECISION_MODEL_KEYS, where, warnings);

	const rawBaseUrl = rawEntry["baseUrl"];
	let baseUrl: string | undefined;
	if (rawBaseUrl !== undefined) {
		if (typeof rawBaseUrl !== "string" || rawBaseUrl.length === 0) {
			throw new ConfigError(`${where}.baseUrl must be a non-empty URL string`, path);
		}
		let parsed: URL;
		try {
			parsed = new URL(rawBaseUrl);
		} catch {
			throw new ConfigError(`${where}.baseUrl is not a valid URL: ${rawBaseUrl}`, path);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new ConfigError(`${where}.baseUrl must be http(s), got ${parsed.protocol}`, path);
		}
		baseUrl = rawBaseUrl;
	}

	const rawApiKey = rawEntry["apiKey"];
	let apiKey: string | undefined;
	if (rawApiKey !== undefined) {
		if (typeof rawApiKey !== "string" || rawApiKey.length === 0) {
			throw new ConfigError(`${where}.apiKey must be a non-empty string`, path);
		}
		apiKey = rawApiKey;
	}
	if (baseUrl !== undefined && apiKey === undefined) {
		throw new ConfigError(
			`${where}.apiKey is required with baseUrl - use "local" for endpoints that ignore the bearer token`,
			path,
		);
	}
	if (apiKey !== undefined && baseUrl === undefined) {
		throw new ConfigError(`${where}.apiKey requires ${where}.baseUrl`, path);
	}
	return {
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(apiKey !== undefined ? { apiKey } : {}),
	};
}

/**
 * Parse the `decisionProviders:` map: connection details keyed by provider id,
 * shared by every decision model of that provider.
 */
function parseDecisionProviders(
	value: unknown,
	path: string,
	warnings: string[],
): Record<string, DecisionProviderEntry> | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) {
		warnings.push(
			`decisionProviders is a map keyed by provider id (e.g. ollama: { baseUrl, apiKey }); the list form was ignored (${path})`,
		);
		return undefined;
	}
	if (!isRecord(value)) throw new ConfigError("decisionProviders must be an object keyed by provider id", path);
	const entries: Record<string, DecisionProviderEntry> = {};
	for (const [provider, rawEntry] of Object.entries(value)) {
		const where = `decisionProviders.${provider}`;
		parseProviderId(provider, where);
		entries[provider] = parseConnectionEntry(rawEntry, where, path, warnings);
	}
	return entries;
}

/**
 * Parse the `decisionModels:` map: per-address connection overrides. Each key is
 * a decision-model address; the value carries the connection details for a
 * direct SystemOne endpoint. Normally the same details live once in
 * `decisionProviders:` instead; this map exists for the one-model-of-a-provider
 * case and for files written before the provider section existed.
 */
function parseDecisionModels(
	value: unknown,
	path: string,
	warnings: string[],
): Record<DecisionModelId, DecisionModelEntry> | undefined {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) {
		warnings.push(
			`decisionModels is now a map keyed by "provider/model-id" (e.g. typesafe/jev-latest: { baseUrl, apiKey }); the list form was ignored (${path})`,
		);
		return undefined;
	}
	if (!isRecord(value)) throw new ConfigError('decisionModels must be an object keyed by "provider/model-id"', path);
	const entries: Record<DecisionModelId, DecisionModelEntry> = {};
	for (const [address, rawEntry] of Object.entries(value)) {
		const where = `decisionModels.${address}`;
		parseModelId(address, where);
		entries[address] = parseConnectionEntry(rawEntry, where, path, warnings);
	}
	return entries;
}

/**
 * Resolve a chain's `decisionModel:` address against the config's connection
 * details.
 *
 * Precedence: a `decisionModels:` entry at the exact address wins, otherwise the
 * provider's `decisionProviders:` entry applies. With neither the address stays
 * catalog-resolved, which pi can do and OpenCode cannot - that stays a visible
 * "no classifier" cycle there instead of a load error, because the same file is
 * valid on pi.
 */
export function resolveDecisionModel(
	decisionModels: Record<DecisionModelId, DecisionModelConfig> | undefined,
	address: DecisionModelId | undefined,
	decisionProviders?: Record<string, DecisionProviderConfig>,
): DecisionModelConfig | undefined {
	if (address === undefined) return undefined;
	const { provider, id } = splitAddress(address, "decisionModel");
	const entry = decisionModels?.[address] ?? decisionProviders?.[provider];
	return {
		provider,
		id,
		...(entry?.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
		...(entry?.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
	};
}

export type {
	SwitchbackConfig,
	SwitchbackFileConfig,
	DecisionModelConfig,
	DecisionModelEntry,
	DecisionProviderEntry,
	DecisionProviderConfig,
	DecisionModelId,
} from "./types.ts";

function parseSwitchbackModel(value: unknown, index: number, warnings: string[]): SwitchbackConfig {
	const where = `models[${index}]`;
	if (!isRecord(value)) throw new ConfigError(`${where} must be an object`, where);
	noteUnknownKeys(value, MODEL_KEYS, where, warnings);
	const id = value["id"];
	const name = value["name"];
	const fallbacks = value["fallbacks"];
	if (typeof id !== "string" || id.length === 0)
		throw new ConfigError(`${where}.id must be a non-empty string`, where);
	// Bare ids are shorthand: `auto` normalises to `switchback/auto`. Physical
	// fallbacks always stay full "provider/id" - they name other providers' models.
	const fullId = id.includes("/") ? id : `${PROVIDER}/${id}`;
	if (typeof name !== "string" || name.length === 0)
		throw new ConfigError(`${where}.name must be a non-empty string`, where);
	if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
		throw new ConfigError(`${where}.fallbacks must be a non-empty array of "provider/id" strings`, where);
	}
	const parsedFallbacks = fallbacks.map((entry, i) => parseModelId(entry, `${where}.fallbacks[${i}]`));
	const rawDecisionModel = value["decisionModel"];
	const decisionModel = rawDecisionModel === undefined ? undefined : parseDecisionModelId(rawDecisionModel, where);
	const idleReset = parseIdleReset(value["idleReset"], where);
	return {
		id: fullId,
		name,
		fallbacks: parsedFallbacks,
		...(decisionModel !== undefined ? { decisionModel } : {}),
		...(idleReset !== undefined ? { idleReset } : {}),
	};
}

/** Parse and validate a model's `idleReset:` setting. */
function parseIdleReset(value: unknown, where: string): IdleResetConfig | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !IDLE_RESET_OPTIONS.includes(value as IdleResetConfig)) {
		throw new ConfigError(`${where}.idleReset must be one of ${IDLE_RESET_OPTIONS.join(", ")}`, where);
	}
	return value as IdleResetConfig;
}

const SECRETS_PREFIX = "secret:";

/**
 * Resolve a `secret:<ref>` apiKey value against a secret store. Anything else
 * (the literal string `ollama`, a real token, etc.) passes through unchanged.
 *
 * An unresolvable reference never fails the load: it becomes a warning and the
 * key is dropped (`apiKey` resolves to `undefined`), so the entry keeps its
 * `baseUrl` and every other decision model stays usable. One unavailable
 * credential must not disable classification for the whole config - a host
 * may have no store at all (OpenCode resolves refs against the environment),
 * and a single unset variable is a routine state, not a broken file. The host
 * reports the warning through its own notify channel.
 */
export function resolveSecretApiKey(
	apiKey: string | undefined,
	secrets: { get(name: string): string | undefined } | undefined,
	warnings: string[] = [],
	where = "<config>",
): string | undefined {
	if (apiKey === undefined) return undefined;
	if (!apiKey.startsWith(SECRETS_PREFIX)) return apiKey;
	const name = apiKey.slice(SECRETS_PREFIX.length);
	if (name.length === 0) {
		warnings.push(`${where}.apiKey "${SECRETS_PREFIX}" is missing a name - the key is ignored`);
		return undefined;
	}
	if (secrets === undefined) {
		warnings.push(
			`${where}.apiKey "${apiKey}" cannot resolve (this host provides no secret store) - the key is ignored`,
		);
		return undefined;
	}
	const value = secrets.get(name);
	if (value === undefined) {
		warnings.push(
			`${where}.apiKey "${apiKey}" does not resolve (secret "${name}" is not in the store) - the key is ignored`,
		);
		return undefined;
	}
	return value;
}

/**
 * Resolve the config into what the router consumes: provider/address connection
 * details with their secret refs resolved, and every chain's address merged with
 * the connection details it inherits (address override first, then provider).
 */
function resolveFile(
	file: SwitchbackFileConfig,
	secrets: { get(name: string): string | undefined } | undefined = undefined,
	warnings: string[] = [],
): ResolvedSwitchbackFileConfig {
	const resolvedDecisionProviders: Record<string, DecisionProviderConfig> | undefined =
		file.decisionProviders === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(file.decisionProviders).map(([provider, entry]) => {
						const apiKey = resolveSecretApiKey(
							entry.apiKey,
							secrets,
							warnings,
							`decisionProviders.${provider}`,
						);
						const descriptor: DecisionProviderConfig = {
							...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
							...(apiKey !== undefined ? { apiKey } : {}),
						};
						return [provider, descriptor];
					}),
				);
	const resolvedDecisionModels: Record<DecisionModelId, DecisionModelConfig> | undefined =
		file.decisionModels === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(file.decisionModels).map(([address, entry]) => {
						const { provider, id } = splitAddress(address, `decisionModels.${address}`);
						const apiKey = resolveSecretApiKey(entry.apiKey, secrets, warnings, `decisionModels.${address}`);
						const descriptor: DecisionModelConfig = {
							provider,
							id,
							...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
							...(apiKey !== undefined ? { apiKey } : {}),
						};
						return [address, descriptor];
					}),
				);
	return {
		models: file.models.map((model) => {
			const { decisionModel, ...rest } = model;
			const resolved = resolveDecisionModel(resolvedDecisionModels, decisionModel, resolvedDecisionProviders);
			return resolved === undefined ? rest : { ...rest, decisionModel: resolved };
		}),
		...(resolvedDecisionProviders !== undefined && Object.keys(resolvedDecisionProviders).length > 0
			? { decisionProviders: resolvedDecisionProviders }
			: {}),
		...(resolvedDecisionModels !== undefined && Object.keys(resolvedDecisionModels).length > 0
			? { decisionModels: resolvedDecisionModels }
			: {}),
		...(file.debug !== undefined ? { debug: file.debug } : {}),
	};
}

function parseFileConfig(value: unknown, path: string, warnings: string[]): SwitchbackFileConfig {
	if (!isRecord(value)) throw new ConfigError("root must be an object", path);
	noteUnknownKeys(value, FILE_KEYS, "config", warnings);
	const models = value["models"];
	if (!Array.isArray(models) || models.length === 0) {
		throw new ConfigError("models must be a non-empty array", path);
	}
	const parsedAll = models.map((entry, i) => parseSwitchbackModel(entry, i, warnings));
	// Any set of virtual model ids is valid - `switchback/auto` is the conventional
	// first entry, not a requirement. An unknown virtual id is already surfaced by
	// findModelConfig() at extension load, and index.ts registers one virtual model
	// per configured entry. A repeated id WITHIN the file keeps the FIRST entry and
	// drops the later ones with a warning: a duplicated chain (a stale editor
	// write, a hand merge) must not take the whole extension down. Each host shows
	// the warning through its own channel (createConfigWarningReporter), and the
	// message names both positions so the extra entry is easy to remove.
	const parsed: SwitchbackConfig[] = [];
	const firstIndex = new Map<string, number>();
	parsedAll.forEach((entry, i) => {
		const first = firstIndex.get(entry.id);
		if (first === undefined) {
			firstIndex.set(entry.id, i);
			parsed.push(entry);
		} else {
			warnings.push(
				`models[${i}] repeats the id "${entry.id}" (first defined at models[${first}]); the later entry was ignored`,
			);
		}
	});
	const rawDebug = value["debug"];
	if (rawDebug !== undefined && typeof rawDebug !== "boolean") {
		throw new ConfigError("debug must be a boolean", path);
	}
	const decisionProviders = parseDecisionProviders(value["decisionProviders"], path, warnings);
	const decisionModels = parseDecisionModels(value["decisionModels"], path, warnings);
	// Unreferenced connection details are not a problem: a provider entry is shared
	// by every model of that provider (and may be prepared before a chain names
	// one), so nothing is "ignored" and nothing can rot. The earlier warning here
	// read like a failure report for a perfectly valid config.
	return {
		models: parsed,
		...(decisionProviders !== undefined ? { decisionProviders } : {}),
		...(decisionModels !== undefined ? { decisionModels } : {}),
		...(rawDebug !== undefined ? { debug: rawDebug } : {}),
	};
}

/**
 * Parse a per-host overlay file. Unlike the base, every section is optional:
 * an overlay may carry only `decisionModels`, only extra `models`, or any
 * combination. Model entries follow the same rules as the base file.
 */
function parseOverlayFileConfig(value: unknown, path: string, warnings: string[]): SwitchbackFileConfig {
	if (value === null || value === undefined) return { models: [] };
	if (!isRecord(value)) throw new ConfigError("root must be an object", path);
	noteUnknownKeys(value, FILE_KEYS, "config", warnings);
	const models = value["models"];
	const parsedAll = models === undefined ? [] : parseOverlayModels(models, path, warnings);
	const rawDebug = value["debug"];
	if (rawDebug !== undefined && typeof rawDebug !== "boolean") {
		throw new ConfigError("debug must be a boolean", path);
	}
	const decisionProviders = parseDecisionProviders(value["decisionProviders"], path, warnings);
	const decisionModels = parseDecisionModels(value["decisionModels"], path, warnings);
	return {
		models: parsedAll,
		...(decisionProviders !== undefined ? { decisionProviders } : {}),
		...(decisionModels !== undefined ? { decisionModels } : {}),
		...(rawDebug !== undefined ? { debug: rawDebug } : {}),
	};
}

function parseOverlayModels(value: unknown, path: string, warnings: string[]): SwitchbackConfig[] {
	if (!Array.isArray(value)) throw new ConfigError("models must be an array", path);
	return value.map((entry, i) => parseSwitchbackModel(entry, i, warnings));
}

/**
 * Merge a host overlay over the base config. Models match by id: an overlay
 * entry with an id already in the base replaces it in place, a new id is
 * appended. `decisionProviders`/`decisionModels` merge per key with the
 * overlay winning; `debug` in the overlay wins when present.
 */
export function mergeFileConfigs(base: SwitchbackFileConfig, overlay: SwitchbackFileConfig): SwitchbackFileConfig {
	const merged = base.models.slice();
	const indexById = new Map(merged.map((m, i) => [m.id, i]));
	for (const model of overlay.models) {
		const at = indexById.get(model.id);
		if (at === undefined) {
			indexById.set(model.id, merged.length);
			merged.push(model);
		} else {
			merged[at] = model;
		}
	}
	return {
		models: merged,
		...(base.decisionProviders !== undefined || overlay.decisionProviders !== undefined
			? { decisionProviders: { ...base.decisionProviders, ...overlay.decisionProviders } }
			: {}),
		...(base.decisionModels !== undefined || overlay.decisionModels !== undefined
			? { decisionModels: { ...base.decisionModels, ...overlay.decisionModels } }
			: {}),
		...(overlay.debug !== undefined
			? { debug: overlay.debug }
			: base.debug !== undefined
				? { debug: base.debug }
				: {}),
	};
}

function readAndParseOverlay(host: SwitchbackHost, warnings: string[]): SwitchbackFileConfig | undefined {
	const path = configOverlayPath(host);
	if (!existsSync(path)) return undefined;
	return parseOverlay(path, warnings);
}

function parseOverlay(path: string, warnings: string[]): SwitchbackFileConfig {
	if (path.endsWith(".json")) {
		throw new ConfigError("switchback user config is YAML only; rename to switchback.oc.yaml", path);
	}
	const text = readFileSync(path, "utf8");
	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (error) {
		throw new ConfigError(
			`switchback config is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
			path,
		);
	}
	return parseOverlayFileConfig(raw, path, warnings);
}

function readAndParse(path: string, warnings: string[]): SwitchbackFileConfig {
	// The only .json file in this project's surface is the simulate fixture;
	// anything else ending in .json is a user config mistake.
	if (path.endsWith(".json")) {
		throw new ConfigError("switchback user config is YAML only; rename to switchback.yaml", path);
	}
	const text = readFileSync(path, "utf8");
	let raw: unknown;
	try {
		raw = parseYaml(text);
	} catch (error) {
		// Surface a malformed file as a typed, path-carrying error instead of the
		// parser's raw stack - a broken config must stop startup loudly.
		throw new ConfigError(
			`switchback config is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
			path,
		);
	}
	const parsed = parseFileConfig(raw, path, warnings);
	return parsed;
}

/**
 * Load the active switchback configuration: the shared base
 * (`configFilePath()`) plus, when `host` is given, that host's overlay
 * (`configOverlayPath(host)`) merged on top. A missing overlay is skipped;
 * a present-but-broken one throws, like the base. With no base file present
 * (and no overlay), DEFAULT_CONFIG (empty fallbacks, fail-fast) applies and
 * `source` is `<default>`; otherwise `source` names the files that were read.
 */

/** A store capable of resolving `secret:<name>` apiKey references. */
export interface SecretResolver {
	get(name: string): string | undefined;
}

/**
 * Load and resolve the user config.
 *
 * `secrets` resolves `apiKey: secret:<name>` references to plaintext. It is
 * injected rather than imported so this module stays free of the secrets store
 * (which itself reads `switchbackStateDir` from here) - production callers pass
 * `createSecretStore()`; tests pass a fake or leave it undefined.
 *
 * `warnings` carries recognised-but-suspicious findings (unknown keys, retired
 * keys, malformed optional values). They never fail the load: a host shows them
 * through its own notify channel. Host *capability* findings are deliberately
 * not here - a decision model that relies on a classifier catalog is fine on pi
 * and impossible on OpenCode, so that judgement belongs to the host
 * (`packages/opencode/src/decision-model-check.ts`).
 */
export function loadConfig(
	secrets?: SecretResolver,
	host?: SwitchbackHost,
): {
	config: ResolvedSwitchbackFileConfig;
	source: string;
	warnings: string[];
} {
	const path = configFilePath();
	const hasBase = existsSync(path);
	const warnings: string[] = [];
	const base = hasBase ? readAndParse(path, warnings) : undefined;
	const overlay = host === undefined ? undefined : readAndParseOverlay(host, warnings);
	if (base === undefined && overlay === undefined)
		return { config: DEFAULT_CONFIG, source: "<default>", warnings: [] };

	const merged = base !== undefined && overlay !== undefined ? mergeFileConfigs(base, overlay) : (base ?? overlay)!;
	const source =
		base !== undefined && overlay !== undefined
			? `${resolve(path)}+${resolve(configOverlayPath(host!))}`
			: base !== undefined
				? resolve(path)
				: resolve(configOverlayPath(host!));
	return { config: resolveFile(merged, secrets, warnings), source, warnings };
}

/**
 * A deduplicating sink for the loader's `warnings`. Both hosts reload the config
 * frequently (pi on every route, OpenCode on every provider transform), so a
 * finding must not repeat per load: the reporter emits a warning set once and
 * stays silent until the set changes. An empty set re-arms the reporter, so a
 * warning that returns after a config fix is shown again.
 */
export function createConfigWarningReporter(): (warnings: readonly string[], emit: (message: string) => void) => void {
	let shown: string | undefined;
	return (warnings, emit) => {
		if (warnings.length === 0) {
			shown = undefined;
			return;
		}
		const key = warnings.join("\n");
		if (key === shown) return;
		shown = key;
		emit(`switchback config: ${warnings.join("; ")}`);
	};
}

/**
 * Validate a raw parsed YAML value against every config rule. The same gate the
 * loader applies; exposed so the interactive config editor validates a mutated
 * document at save time instead of maintaining a second rule set.
 */
export function validateFileConfig(raw: unknown, path: string): { config: SwitchbackFileConfig; warnings: string[] } {
	const warnings: string[] = [];
	const config = parseFileConfig(raw, path, warnings);
	return { config, warnings };
}

/** Look up the configuration entry for a given virtual model id. */
export function findModelConfig(config: ResolvedSwitchbackFileConfig, virtualId: string): ResolvedSwitchbackConfig {
	const entry = config.models.find((m) => m.id === virtualId);
	if (!entry) throw new ConfigError(`no config entry for virtual model "${virtualId}"`, "<config>");
	if (entry.fallbacks.length === 0) {
		throw new ConfigError(
			`switchback has no fallbacks configured (source: ${entry.id}). Configure fallbacks in ${configFilePath()} and re-launch.`,
			"<default>",
		);
	}
	return entry;
}

export const SWITCHBACK_PROVIDER = PROVIDER;
export const SWITCHBACK_VIRTUAL_ID = VIRTUAL_ID;
