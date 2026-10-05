/**
 * User-facing switchback config loader.
 *
 * Lookup order:
 *   1. <cwd>/switchback.yaml
 *   2. <piConfigDir>/switchback.yaml     (piConfigDir = ~/.pi/agent by default)
 *   3. built-in DEFAULT_CONFIG
 *
 * The first match that parses and validates wins. Errors in the chosen config
 * throw - they should be surfaced immediately, not silently fallen through to a
 * default.
 *
 * DEFAULT_CONFIG ships with `fallbacks: []` (no provider hardcoded) so a configless
 * user gets a clear, actionable error instead of a silently-broken router. The
 * fail-fast happens at extension load: `findModelConfig()` throws ConfigError
 * from index.ts:24 (module top level) before route()/decide() ever runs. The
 * message names the two known fixes ("Ship switchback.yaml or set the agent-dir
 * copy at ~/.pi/agent/switchback.yaml and re-launch."). Until the user does
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
import type { ModelId, SwitchbackConfig, SwitchbackFileConfig } from "./types.ts";

const PROVIDER = "switchback";
const VIRTUAL_ID = "auto";
const CONFIG_BASENAME = "switchback";

/** Classifier wire APIs switchback can drive from a direct endpoint. */
const SUPPORTED_LOCAL_CLASSIFIER_APIS: readonly string[] = ["typesafe-system-one"];

/**
 * Built-in default used when no user config is present.
 *
 * Empty by design: an empty fallback list routes to the `config-invalid`
 * decision path so the user gets a clear, actionable error instead of a
 * silently-broken router. The shipped `switchback.yaml` (or a per-project
 * override) is what fills this in.
 */
export const DEFAULT_CONFIG: SwitchbackFileConfig = {
	models: [
		{
			id: `${PROVIDER}/${VIRTUAL_ID}`,
			name: "Auto (Switchback)",
			fallbacks: [],
		},
	],
};

export class ConfigError extends Error {
	constructor(message: string, public readonly path: string) {
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
 * The switchback subdirectory under the agent config dir. Runtime files
 * (blocks.json, crashes.json) live here so they are account-scoped, not
 * project-scoped: a block on `zai/glm-5.3` for hitting the 5h window is a
 * fact about the account's quota, not the project on disk.
 */
export function piSwitchbackDir(): string {
	return join(piConfigDir(), "switchback");
}

function candidatePaths(): string[] {
	const cwd = process.cwd();
	const cfg = piConfigDir();
	// YAML-only: switchback.yaml is the human-facing config. The .json sibling is
	// dropped from the candidate list - the only JSON files that ship in this
	// project are machine-managed (`<piConfigDir>/switchback/blocks.json` runtime
	// state, the simulate fixture `switchback.simulate.json`).
	return [
		join(cwd, `${CONFIG_BASENAME}.yaml`),
		join(cfg, `${CONFIG_BASENAME}.yaml`),
	];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelId(value: unknown, where: string): ModelId {
	if (typeof value !== "string") throw new ConfigError(`${where} must be a string (e.g. "provider/id")`, where);
	if (value.indexOf("/") <= 0) throw new ConfigError(`${where} must be of the form "provider/id"`, where);
	return value;
}

function parseJev(value: unknown, where: string): SwitchbackConfig["jev"] {
	if (value === undefined) return undefined;
	if (!isRecord(value)) throw new ConfigError(`${where}.jev must be an object`, where);
	const provider = value["provider"];
	const id = value["id"];
	if (typeof provider !== "string" || provider.length === 0) {
		throw new ConfigError(`${where}.jev.provider must be a non-empty string`, where);
	}
	if (typeof id !== "string" || id.length === 0) {
		throw new ConfigError(`${where}.jev.id must be a non-empty string`, where);
	}

	// Optional direct endpoint (a local System One server, e.g. Ollama v0.35+).
	// Presence of baseUrl switches switchback from "look the classifier up in
	// pi's catalog" to "register this endpoint ourselves".
	const rawBaseUrl = value["baseUrl"];
	let baseUrl: string | undefined;
	if (rawBaseUrl !== undefined) {
		if (typeof rawBaseUrl !== "string" || rawBaseUrl.length === 0) {
			throw new ConfigError(`${where}.jev.baseUrl must be a non-empty URL string`, where);
		}
		let parsed: URL;
		try {
			parsed = new URL(rawBaseUrl);
		} catch {
			throw new ConfigError(`${where}.jev.baseUrl is not a valid URL: ${rawBaseUrl}`, where);
		}
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
			throw new ConfigError(`${where}.jev.baseUrl must be http(s), got ${parsed.protocol}`, where);
		}
		baseUrl = rawBaseUrl;
	}

	const rawApi = value["api"];
	let api: string | undefined;
	if (rawApi !== undefined) {
		if (typeof rawApi !== "string" || !SUPPORTED_LOCAL_CLASSIFIER_APIS.includes(rawApi)) {
			throw new ConfigError(
				`${where}.jev.api must be one of: ${SUPPORTED_LOCAL_CLASSIFIER_APIS.join(", ")}`,
				where,
			);
		}
		api = rawApi;
	}
	if (api !== undefined && baseUrl === undefined) {
		throw new ConfigError(`${where}.jev.api requires ${where}.jev.baseUrl`, where);
	}

	const rawApiKey = value["apiKey"];
	let apiKey: string | undefined;
	if (rawApiKey !== undefined) {
		if (typeof rawApiKey !== "string" || rawApiKey.length === 0) {
			throw new ConfigError(`${where}.jev.apiKey must be a non-empty string`, where);
		}
		apiKey = rawApiKey;
	}
	if (apiKey !== undefined && baseUrl === undefined) {
		throw new ConfigError(`${where}.jev.apiKey requires ${where}.jev.baseUrl`, where);
	}

	return {
		provider,
		id,
		...(baseUrl !== undefined ? { baseUrl } : {}),
		...(api !== undefined ? { api } : {}),
		...(apiKey !== undefined ? { apiKey } : {}),
	};
}

export type { SwitchbackConfig, SwitchbackFileConfig, JevConfig } from "./types.ts";

function parseSwitchbackModel(value: unknown, index: number): SwitchbackConfig {
	const where = `models[${index}]`;
	if (!isRecord(value)) throw new ConfigError(`${where} must be an object`, where);
	const id = value["id"];
	const name = value["name"];
	const fallbacks = value["fallbacks"];
	if (typeof id !== "string" || id.length === 0) throw new ConfigError(`${where}.id must be a non-empty string`, where);
	if (typeof name !== "string" || name.length === 0) throw new ConfigError(`${where}.name must be a non-empty string`, where);
	if (!Array.isArray(fallbacks) || fallbacks.length === 0) {
		throw new ConfigError(`${where}.fallbacks must be a non-empty array of "provider/id" strings`, where);
	}
	const parsedFallbacks = fallbacks.map((entry, i) => parseModelId(entry, `${where}.fallbacks[${i}]`));
	const jev = parseJev(value["jev"], where);
	return { id, name, fallbacks: parsedFallbacks, ...(jev ? { jev } : {}) };
}

function parseFileConfig(value: unknown, path: string): SwitchbackFileConfig {
	if (!isRecord(value)) throw new ConfigError("root must be an object", path);
	const models = value["models"];
	if (!Array.isArray(models) || models.length === 0) {
		throw new ConfigError("models must be a non-empty array", path);
	}
	const parsed = models.map((entry, i) => parseSwitchbackModel(entry, i));
	// Require the auto virtual model to be present.
	const autoId = `${PROVIDER}/${VIRTUAL_ID}`;
	if (!parsed.some((m) => m.id === autoId)) {
		throw new ConfigError(`models must include an entry with id "${autoId}"`, path);
	}
	return { models: parsed };
}

function readAndParse(path: string): SwitchbackFileConfig {
	// YAML-only user config. The .json extension is rejected up here defensively
	// so a stray user.json file (e.g. left over from an earlier version) is not
	// silently parsed as JSON; instead the parse layer raises a clear error.
	if (path.endsWith(".json")) {
		throw new ConfigError("switchback user config is YAML only; rename to switchback.yaml", path);
	}
	const text = readFileSync(path, "utf8");
	const raw: unknown = parseYaml(text);
	return parseFileConfig(raw, path);
}

/** Load the active switchback configuration. Resolves the first valid match against the lookup order. */
export function loadConfig(): { config: SwitchbackFileConfig; source: string } {
	for (const path of candidatePaths()) {
		if (!existsSync(path)) continue;
		return { config: readAndParse(path), source: resolve(path) };
	}
	return { config: DEFAULT_CONFIG, source: "<default>" };
}

/** Look up the configuration entry for a given virtual model id. */
export function findModelConfig(config: SwitchbackFileConfig, virtualId: string): SwitchbackConfig {
	const entry = config.models.find((m) => m.id === virtualId);
	if (!entry) throw new ConfigError(`no config entry for virtual model "${virtualId}"`, "<config>");
	if (entry.fallbacks.length === 0) {
		throw new ConfigError(
			`switchback has no fallbacks configured (source: ${entry.id}). Ship switchback.yaml or set the agent-dir copy at ~/.pi/agent/switchback.yaml and re-launch.`,
			"<default>",
		);
	}
	return entry;
}

export const SWITCHBACK_PROVIDER = PROVIDER;
export const SWITCHBACK_VIRTUAL_ID = VIRTUAL_ID;
