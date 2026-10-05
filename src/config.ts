/**
 * User-facing switchback config loader.
 *
 * Config layers (all YAML, all optional):
 *   1. <cwd>/.pi/switchback.yaml            (per-project layer)
 *   2. <piConfigDir>/switchback.yaml        (global layer; piConfigDir = ~/.pi/agent)
 *   3. built-in DEFAULT_CONFIG              (only when neither file exists)
 *
 * The two user layers are AGGREGATED, not first-match-wins: the merged model
 * list is the global list with project entries overriding same-id entries in
 * place and project-only entries appended. A layer that exists but fails to
 * parse or validate throws immediately - a broken layer is surfaced, never
 * silently dropped in favour of the other.
 *
 * The project-local slot lives under `.pi/` deliberately: `.pi/` is ignored by
 * git (pi's own convention), so a per-project override can never be committed
 * into a repository the way a repo-root `switchback.yaml` would be. The repo
 * ships only `switchback.yaml.example` as the template.
 *
 * DEFAULT_CONFIG ships with `fallbacks: []` (no provider hardcoded) so a configless
 * user gets a clear, actionable error instead of a silently-broken router. The
 * fail-fast happens at extension load: `findModelConfig()` throws ConfigError
 * from index.ts (module top level) before route()/decide() ever runs. The
 * message names the two known fixes ("Configure fallbacks in <cwd>/.pi/switchback.yaml
 * or ~/.pi/agent/switchback.yaml and re-launch."). Until the user does
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
 * silently-broken router. A project-local `.pi/switchback.yaml` or the
 * agent-dir copy is what fills this in.
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
	// The project-local slot is `.pi/`, which git ignores, so a per-project
	// override never lands in a repository.
	return [
		join(cwd, ".pi", `${CONFIG_BASENAME}.yaml`),
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
	// Any set of virtual model ids is valid - `switchback/auto` is the conventional
	// first entry, not a requirement. An unknown virtual id is already surfaced by
	// findModelConfig() at extension load, and index.ts registers one virtual model
	// per configured entry. A duplicated id WITHIN a file is rejected here: layers
	// may legitimately override each other, but one file must not contradict itself.
	const seen = new Set<string>();
	for (const entry of parsed) {
		if (seen.has(entry.id)) {
			throw new ConfigError(`models contains the id "${entry.id}" more than once`, path);
		}
		seen.add(entry.id);
	}
	return { models: parsed };
}

function readAndParse(path: string): SwitchbackFileConfig {
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
		// Surface a malformed layer as a typed, path-carrying error instead of the
		// parser's raw stack - a broken layer must stop startup loudly either way.
		throw new ConfigError(
			`switchback config is not valid YAML: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`,
			path,
		);
	}
	return parseFileConfig(raw, path);
}

/**
 * Merge a per-project config on top of the agent-dir (global) config.
 *
 * Aggregation unit is the virtual-model entry: the merged list keeps the global
 * order as its base, a project entry with the same id replaces the global entry
 * in place (the project entry wins wholesale - fallbacks, name and classifier -
 * there is no field-level merging), and project-only models are appended after
 * the global ones in project order. With no global config the project config
 * stands alone, and vice versa.
 */
function aggregateConfigs(global: SwitchbackFileConfig, project: SwitchbackFileConfig): SwitchbackFileConfig {
	const merged = [...global.models];
	for (const projectEntry of project.models) {
		const index = merged.findIndex((m) => m.id === projectEntry.id);
		if (index === -1) merged.push(projectEntry);
		else merged[index] = projectEntry;
	}
	return { models: merged };
}

/**
 * Load the active switchback configuration.
 *
 * The per-project file (`<cwd>/.pi/switchback.yaml`) and the agent-dir copy
 * (`<piConfigDir>/switchback.yaml`) are AGGREGATED, not first-match-wins: the
 * merged model list is the global list with project entries overriding
 * same-id entries in place and project-only entries appended. A file that
 * exists but fails to parse or validate throws immediately - a broken layer is
 * surfaced, never silently dropped. With neither file present, DEFAULT_CONFIG
 * (empty fallbacks, fail-fast) applies.
 */
export function loadConfig(): { config: SwitchbackFileConfig; source: string } {
	const [projectPath, agentPath] = candidatePaths() as [string, string];
	const projectExists = existsSync(projectPath);
	const agentExists = existsSync(agentPath);
	if (projectExists) {
		const project = readAndParse(projectPath);
		if (agentExists) {
			const agent = readAndParse(agentPath);
			return {
				config: aggregateConfigs(agent, project),
				source: `${resolve(projectPath)} + ${resolve(agentPath)}`,
			};
		}
		return { config: project, source: resolve(projectPath) };
	}
	if (agentExists) {
		return { config: readAndParse(agentPath), source: resolve(agentPath) };
	}
	return { config: DEFAULT_CONFIG, source: "<default>" };
}

/** Look up the configuration entry for a given virtual model id. */
export function findModelConfig(config: SwitchbackFileConfig, virtualId: string): SwitchbackConfig {
	const entry = config.models.find((m) => m.id === virtualId);
	if (!entry) throw new ConfigError(`no config entry for virtual model "${virtualId}"`, "<config>");
	if (entry.fallbacks.length === 0) {
		throw new ConfigError(
			`switchback has no fallbacks configured (source: ${entry.id}). Configure fallbacks in <cwd>/.pi/switchback.yaml or ~/.pi/agent/switchback.yaml and re-launch.`,
			"<default>",
		);
	}
	return entry;
}

export const SWITCHBACK_PROVIDER = PROVIDER;
export const SWITCHBACK_VIRTUAL_ID = VIRTUAL_ID;
