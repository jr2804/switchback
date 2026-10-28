/**
 * User-facing switchback config loader.
 *
 * Config file (YAML, optional): `~/.config/switchback/switchback.yaml`, one file
 * shared by every host. There are no host-specific or per-project layers: a
 * host-specific overlay would let the two hosts disagree about the chain set,
 * and they do not share a model catalog, so an entry one host cannot resolve
 * would become a dead fallback on the other (`switchback-wix.12`). When the file
 * is absent, the built-in DEFAULT_CONFIG applies.
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
const FILE_KEYS = ["models", "decisionModels", "debug"] as const;
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
 * Where the user config lives. One file, shared by every host:
 * `~/.config/switchback/switchback.yaml`. There are no host-specific or
 * project-local files - a host that reads switchback reads exactly this file
 * (`switchback-wix.12`).
 */
export function configFilePath(): string {
	return join(switchbackConfigDir(), `${CONFIG_BASENAME}.yaml`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
 * Parse the `decisionModels:` map. Each key is a decision-model address; the
 * value carries the connection details for a direct SystemOne endpoint.
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
			// A direct endpoint needs a bearer token to send. Local servers ignore
			// it, but the token is still the thing that makes "direct endpoint"
			// explicit rather than a silent default.
			throw new ConfigError(
				`${where}.apiKey is required with baseUrl - use "local" for endpoints that ignore the bearer token`,
				path,
			);
		}
		if (apiKey !== undefined && baseUrl === undefined) {
			throw new ConfigError(`${where}.apiKey requires ${where}.baseUrl`, path);
		}
		if (baseUrl === undefined) {
			warnings.push(
				`${where} has no connection details; it can only resolve through a classifier catalog (pi has one, OpenCode does not)`,
			);
		}
		entries[address] = {
			...(baseUrl !== undefined ? { baseUrl } : {}),
			...(apiKey !== undefined ? { apiKey } : {}),
		};
	}
	return entries;
}

/**
 * Resolve a chain's `decisionModel:` address against the `decisionModels:` map.
 *
 * A map entry with a `baseUrl` pins the endpoint. Without one the address stays
 * catalog-resolved, which pi can do and OpenCode cannot - that stays a visible
 * "no classifier" cycle there instead of a load error, because the same file is
 * valid on pi.
 */
export function resolveDecisionModel(
	decisionModels: Record<DecisionModelId, DecisionModelConfig> | undefined,
	address: DecisionModelId | undefined,
): DecisionModelConfig | undefined {
	if (address === undefined) return undefined;
	const { provider, id } = splitAddress(address, "decisionModel");
	const entry = decisionModels?.[address];
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
 * A missing reference throws `SecretsError` (re-raised by the caller) - a secret
 * reference that does not resolve is a user error, not a silent default.
 */
export function resolveSecretApiKey(
	apiKey: string | undefined,
	secrets: { get(name: string): string | undefined } | undefined,
): string | undefined {
	if (apiKey === undefined) return undefined;
	if (!apiKey.startsWith(SECRETS_PREFIX)) return apiKey;
	if (secrets === undefined) {
		throw new ConfigError(
			`apiKey starts with "${SECRETS_PREFIX}" but no secret store was provided - pass one to loadConfig() or define the key in the secret store first.`,
			"<config>",
		);
	}
	const name = apiKey.slice(SECRETS_PREFIX.length);
	if (name.length === 0) {
		throw new ConfigError(`apiKey "${SECRETS_PREFIX}" is missing a name`, "<config>");
	}
	const value = secrets.get(name);
	if (value === undefined) {
		throw new ConfigError(`apiKey "${apiKey}" does not resolve (secret "${name}" is not in the store)`, "<config>");
	}
	return value;
}

/** Resolve every chain's `decisionModel:` address against the map, and the map's secret refs. */
function resolveFile(
	file: SwitchbackFileConfig,
	secrets: { get(name: string): string | undefined } | undefined = undefined,
): ResolvedSwitchbackFileConfig {
	const resolvedDecisionModels: Record<DecisionModelId, DecisionModelConfig> | undefined =
		file.decisionModels === undefined
			? undefined
			: Object.fromEntries(
					Object.entries(file.decisionModels).map(([address, entry]) => {
						const { provider, id } = splitAddress(address, `decisionModels.${address}`);
						const apiKey = resolveSecretApiKey(entry.apiKey, secrets);
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
			const resolved = resolveDecisionModel(resolvedDecisionModels, decisionModel);
			return resolved === undefined ? rest : { ...rest, decisionModel: resolved };
		}),
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
	const parsed = models.map((entry, i) => parseSwitchbackModel(entry, i, warnings));
	// Any set of virtual model ids is valid - `switchback/auto` is the conventional
	// first entry, not a requirement. An unknown virtual id is already surfaced by
	// findModelConfig() at extension load, and index.ts registers one virtual model
	// per configured entry. A duplicated id WITHIN the file is rejected here:
	// may legitimately override each other, but one file must not contradict itself.
	const seen = new Set<string>();
	for (const entry of parsed) {
		if (seen.has(entry.id)) {
			throw new ConfigError(`models contains the id "${entry.id}" more than once`, path);
		}
		seen.add(entry.id);
	}
	const rawDebug = value["debug"];
	if (rawDebug !== undefined && typeof rawDebug !== "boolean") {
		throw new ConfigError("debug must be a boolean", path);
	}
	const decisionModels = parseDecisionModels(value["decisionModels"], path, warnings);
	// A `decisionModels` entry no chain references is harmless but almost always a
	// leftover: warn (do not fail) so the block does not quietly rot.
	if (decisionModels !== undefined) {
		const referenced = new Set(parsed.map((model) => model.decisionModel).filter((id) => id !== undefined));
		for (const address of Object.keys(decisionModels)) {
			if (!referenced.has(address)) {
				warnings.push(
					`decisionModels.${address} is not referenced by any models[].decisionModel and was ignored`,
				);
			}
		}
	}
	return {
		models: parsed,
		...(decisionModels !== undefined ? { decisionModels } : {}),
		...(rawDebug !== undefined ? { debug: rawDebug } : {}),
	};
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
 * Load the active switchback configuration from `configFilePath()`.
 *
 * Exactly one file is read. There is no aggregation and no precedence: a
 * host-specific overlay would let the two hosts disagree about the chain set,
 * and they do not share a model catalog, so an entry one host cannot resolve
 * would become a dead fallback on the other. A file that exists but fails to
 * parse or validate throws immediately. With no file present, DEFAULT_CONFIG
 * (empty fallbacks, fail-fast) applies and `source` is `<default>`.
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
 * keys, unreferenced decision models). They never fail the load: a host shows
 * them through its own notify channel.
 */
export function loadConfig(secrets?: SecretResolver): {
	config: ResolvedSwitchbackFileConfig;
	source: string;
	warnings: string[];
} {
	const path = configFilePath();
	if (!existsSync(path)) return { config: DEFAULT_CONFIG, source: "<default>", warnings: [] };

	const warnings: string[] = [];
	const parsed = readAndParse(path, warnings);
	return { config: resolveFile(parsed, secrets), source: resolve(path), warnings };
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
