/**
 * Comment-preserving read-modify-write editor for switchback.yaml.
 *
 * Design: `src/config.ts` parses user config with `yaml.parse()`, which
 * keeps values but discards comments - fine for loading, lossy for editing.
 * The interactive dialogue (`packages/pi/src/dialogue.ts`) must round-trip a user's
 * hand-annotated YAML, so this module parses with `parseDocument()` and
 * mutates the Document's nodes in place: existing keys, their order and
 * their comments survive, and only newly created content is synthesized.
 *
 * Validation lives in exactly one place. Every mutation is structural only
 * (locate a node, set/splice/delete); `saveConfigFile()` re-validates the whole
 * document through the exported `validateFileConfig()` - the same gate the
 * loader applies. The editor therefore carries no rule set of its own: a save
 * either produces exactly what `loadConfig()` would accept, or throws the
 * loader's own ConfigError messages.
 *
 * Secrets: API keys never enter the file as literals. The decision-model
 * operations accept a secret NAME (`apiKeySecretName`), and the value is
 * written as `secret:<name>`; storing the value itself is the dialogue's
 * job via the encrypted store (`packages/pi/src/secrets.ts`). The type shape makes a
 * literal key unrepresentable at this boundary.
 *
 * One file: `configFilePath()` (`~/.config/switchback/switchback.yaml`), the same
 * config both hosts read. There are no host-specific or per-project layers to
 * choose between (`switchback-wix.12`).
 *
 * Writes are atomic - tmp file + rename, the `state.ts` pattern - and the
 * parent directory is created on demand, so a first save into a fresh install
 * works without ceremony.
 */

import { existsSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic-write.ts";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { ConfigError, configFilePath, validateFileConfig } from "./config.ts";
import type { IdleResetConfig, ModelId, SwitchbackFileConfig } from "./types.ts";

/**
 * A config file loaded for editing: the parsed Document plus where it lives.
 *
 * There is one file, `configFilePath()`, and therefore nothing to choose between.
 */
export interface LoadedConfig {
	/** Absolute path of the config file; shown in every dialogue screen title. */
	path: string;
	/** False when the file does not exist yet and the editor started fresh. */
	existed: boolean;
	doc: Document;
}

/** Header comment written when the editor creates the config file from scratch. */
const NEW_FILE_HEADER = [
	"switchback configuration - see docs/configuration.md",
	"Read by every switchback host (pi and OpenCode) from this one file.",
	"API keys are secret-store references (`secret:<name>`), never literal values.",
].join("\n");

/**
 * Parse the config file for editing. A missing file yields an empty Document
 * that carries the header comment; the first save creates it. A file that is not
 * valid YAML throws ConfigError - the editor opens valid config only, and a
 * broken file is surfaced for a hand fix rather than silently rewritten.
 */
export function loadConfigFile(): LoadedConfig {
	const path = configFilePath();
	if (!existsSync(path)) {
		const doc = parseDocument("");
		doc.commentBefore = NEW_FILE_HEADER;
		return { path, existed: false, doc };
	}
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new ConfigError(`cannot read config: ${errorMessage(error)}`, path);
	}
	const doc = parseDocument(text);
	const firstError = doc.errors[0];
	if (firstError !== undefined) {
		throw new ConfigError(`switchback config is not valid YAML: ${String(firstError.message)}`, path);
	}
	return { path, existed: true, doc };
}

/**
 * The file's current config, validated by the loader's own gate. Throws
 * ConfigError when the on-disk document does not satisfy the config rules;
 * the dialogue surfaces that and declines to edit rather than round-tripping
 * an invalid state.
 */
export function readConfigFile(loaded: LoadedConfig): SwitchbackFileConfig {
	return validateFileConfig(loaded.doc.toJSON(), loaded.path).config;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The `models:` sequence; created on demand for a fresh config file. */
function requireModelsSeq(loaded: LoadedConfig): YAMLSeq {
	const models = loaded.doc.get("models");
	if (models === undefined || models === null) {
		// A fresh file has no models key yet; the dialogue starts by adding one.
		const created = loaded.doc.createNode([]) as YAMLSeq;
		loaded.doc.set("models", created);
		return created;
	}
	if (!isSeq(models)) throw new ConfigError("models must be an array", loaded.path);
	return models;
}

/** Find a model entry node by virtual-model id; both sides are normalized, so a file storing a bare `auto` is found by `switchback/auto` and vice versa. */
function findModelNode(loaded: LoadedConfig, virtualId: string): { seq: YAMLSeq; index: number; node: YAMLMap } {
	const seq = requireModelsSeq(loaded);
	const wanted = normalizeVirtualId(virtualId);
	for (const [index, item] of seq.items.entries()) {
		if (item === null || !isMap(item)) continue;
		const stored = item.get("id");
		if (typeof stored === "string" && normalizeVirtualId(stored) === wanted) {
			return { seq, index, node: item };
		}
	}
	throw new ConfigError(`no config entry for virtual model "${wanted}"`, loaded.path);
}

/** `auto` is shorthand for `switchback/auto` (the parser's normalization, applied on write). */
function normalizeVirtualId(virtualId: string): string {
	return virtualId.includes("/") ? virtualId : `switchback/${virtualId}`;
}

/** Structural duplicate check (normalized both sides) so the dialogue errors at the offending action, not only at save. */
function assertModelIdAvailable(loaded: LoadedConfig, fullId: string): void {
	const seq = requireModelsSeq(loaded);
	for (const item of seq.items) {
		if (item === null || !isMap(item)) continue;
		const stored = item.get("id");
		if (typeof stored === "string" && normalizeVirtualId(stored) === fullId) {
			throw new ConfigError(`models contains the id "${fullId}" more than once`, loaded.path);
		}
	}
}

/**
 * Append a virtual model entry. `id` may be bare (`auto`) and is written in
 * the full `switchback/...` form. Fallback content is validated at save time
 * by `validateFileConfig`, so the user sees the loader's own message if a
 * fallback misses its `provider/id` form.
 */
export function addVirtualModel(loaded: LoadedConfig, input: { id: string; name: string; fallbacks: ModelId[] }): void {
	const fullId = normalizeVirtualId(input.id);
	assertModelIdAvailable(loaded, fullId);
	const seq = requireModelsSeq(loaded);
	seq.items.push(loaded.doc.createNode({ id: fullId, name: input.name, fallbacks: [...input.fallbacks] }));
}

/** Remove a virtual model entry by id (bare ids normalized). Confirm-gated by the dialogue. */
export function removeVirtualModel(loaded: LoadedConfig, virtualId: string): void {
	const { seq, index } = findModelNode(loaded, virtualId);
	seq.items.splice(index, 1);
}

/** Change a virtual model's id. The running pi keeps the old registration until restart. */
export function renameVirtualModel(loaded: LoadedConfig, oldId: string, newId: string): void {
	const fullNewId = normalizeVirtualId(newId);
	const old = normalizeVirtualId(oldId);
	if (fullNewId !== old) assertModelIdAvailable(loaded, fullNewId);
	const { node } = findModelNode(loaded, oldId);
	node.set("id", fullNewId);
}

/** Change a virtual model's display name. */
export function setVirtualModelName(loaded: LoadedConfig, virtualId: string, name: string): void {
	const { node } = findModelNode(loaded, virtualId);
	node.set("name", name);
}

/** Replace a model's whole fallback list (ordered; first entry is preferred). */
export function setFallbacks(loaded: LoadedConfig, virtualId: string, fallbacks: ModelId[]): void {
	const { node } = findModelNode(loaded, virtualId);
	node.set("fallbacks", loaded.doc.createNode([...fallbacks]));
}

/** Append one fallback at the end of the model's preference list. */
export function addFallback(loaded: LoadedConfig, virtualId: string, fallback: ModelId): void {
	const { node } = findModelNode(loaded, virtualId);
	const seq = node.get("fallbacks");
	if (seq === undefined || seq === null || !isSeq(seq)) {
		throw new ConfigError("fallbacks must be an array", loaded.path);
	}
	seq.items.push(loaded.doc.createNode(fallback));
}

/** Remove the fallback at `index` (bounds-checked; the dialogue passes the picked position). */
export function removeFallback(loaded: LoadedConfig, virtualId: string, index: number): void {
	const { node } = findModelNode(loaded, virtualId);
	const seq = node.get("fallbacks");
	if (seq === undefined || seq === null || !isSeq(seq) || index < 0 || index >= seq.items.length) {
		throw new ConfigError(`fallback index ${index} out of range`, loaded.path);
	}
	seq.items.splice(index, 1);
}

/** Move a fallback from one position to another (the dialogue's up/down reordering). */
export function moveFallback(loaded: LoadedConfig, virtualId: string, from: number, to: number): void {
	const { node } = findModelNode(loaded, virtualId);
	const seq = node.get("fallbacks");
	if (
		seq === undefined ||
		seq === null ||
		!isSeq(seq) ||
		from < 0 ||
		from >= seq.items.length ||
		to < 0 ||
		to >= seq.items.length
	) {
		throw new ConfigError(`fallback move ${from} -> ${to} out of range`, loaded.path);
	}
	const [moved] = seq.items.splice(from, 1);
	if (moved === undefined) throw new ConfigError(`fallback index ${from} out of range`, loaded.path);
	seq.items.splice(to, 0, moved);
}

/**
 * Set or clear a model's decision model. `null` clears the key (the model then
 * reports and blind-cycles without classifying). The value is a decision-model
 * address ("provider/model-id"); connection details, when the address needs a
 * direct endpoint, live in the top-level `decisionModels:` map under the same
 * address.
 */
export function setDecisionModel(loaded: LoadedConfig, virtualId: string, address: string | null): void {
	const { node } = findModelNode(loaded, virtualId);
	if (address === null) {
		node.delete("decisionModel");
		return;
	}
	node.set("decisionModel", address);
}

/** A decision-model entry as the editor accepts it. */
export interface DecisionModelInput {
	/** "provider/model-id" - the map key, and the value a chain names. */
	address: string;
	/** Direct SystemOne endpoint; omit for catalog resolution. */
	baseUrl?: string;
	/**
	 * Secret-store name, written as `secret:<name>`. Omit for an endpoint that
	 * ignores the bearer token; the entry then carries `apiKey: local`.
	 */
	apiKeySecretName?: string;
}

/** Field-level patch for an existing decision model; `null` clears the field. */
export interface DecisionModelPatch {
	/** `null` also clears `apiKey` (the loader rule: it requires baseUrl). */
	baseUrl?: string | null;
	/** `null` writes `apiKey: local` - only meaningful with a baseUrl. */
	apiKeySecretName?: string | null;
}

/** A `decisionModels:` map value as the parser produces it. */
interface DecisionModelNode {
	baseUrl?: string;
	apiKey?: string;
}

function decisionModelToNode(doc: Document, input: DecisionModelInput): YAMLMap {
	const entry: DecisionModelNode = {
		...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
		...(input.baseUrl !== undefined
			? { apiKey: input.apiKeySecretName === undefined ? "local" : `secret:${input.apiKeySecretName}` }
			: {}),
	};
	return doc.createNode(entry) as YAMLMap;
}

function requireDecisionModelsMap(loaded: LoadedConfig): YAMLMap {
	const map = loaded.doc.get("decisionModels");
	if (map === undefined || map === null) {
		const created = loaded.doc.createNode({}) as YAMLMap;
		loaded.doc.set("decisionModels", created);
		return created;
	}
	if (!isMap(map)) {
		throw new ConfigError('decisionModels must be a map keyed by "provider/model-id"', loaded.path);
	}
	return map;
}

/** Find a decisionModels entry node by its address (the map key). */
function findDecisionModelNode(loaded: LoadedConfig, address: string): { map: YAMLMap; node: YAMLMap } {
	const map = requireDecisionModelsMap(loaded);
	const node = map.get(address, true);
	if (node === undefined || node === null || !isMap(node)) {
		throw new ConfigError(`decisionModels.${address} not found`, loaded.path);
	}
	return { map, node };
}

/** Add a decision-model entry (duplicate addresses fail the save via `validateFileConfig`). */
export function addDecisionModel(loaded: LoadedConfig, input: DecisionModelInput): void {
	const map = requireDecisionModelsMap(loaded);
	if (map.has(input.address)) {
		throw new ConfigError(`decisionModels already contains "${input.address}"`, loaded.path);
	}
	map.set(input.address, decisionModelToNode(loaded.doc, input));
}

/** Patch one decision model's connection details. */
export function updateDecisionModel(loaded: LoadedConfig, address: string, patch: DecisionModelPatch): void {
	const { node } = findDecisionModelNode(loaded, address);
	if (patch.baseUrl !== undefined) {
		if (patch.baseUrl === null) {
			node.delete("baseUrl");
			// apiKey is only valid alongside baseUrl; clearing baseUrl clears it.
			node.delete("apiKey");
		} else {
			node.set("baseUrl", patch.baseUrl);
			if (!node.has("apiKey")) node.set("apiKey", "local");
		}
	}
	if (patch.apiKeySecretName !== undefined) {
		node.set("apiKey", patch.apiKeySecretName === null ? "local" : `secret:${patch.apiKeySecretName}`);
	}
}

/**
 * Rename a decision-model address and rewrite every `models[].decisionModel`
 * that names it in the same transaction, so a rename cannot dangle references.
 */
export function renameDecisionModel(loaded: LoadedConfig, oldAddress: string, newAddress: string): void {
	if (oldAddress !== newAddress) {
		const { map, node } = findDecisionModelNode(loaded, oldAddress);
		if (map.has(newAddress)) {
			throw new ConfigError(`decisionModels already contains "${newAddress}"`, loaded.path);
		}
		map.delete(oldAddress);
		map.set(newAddress, node);
	}
	for (const item of requireModelsSeq(loaded).items) {
		if (item === null || !isMap(item)) continue;
		if (item.get("decisionModel") === oldAddress) item.set("decisionModel", newAddress);
	}
}

/**
 * Remove a decision model. References are NOT rewritten: a chain that still
 * names the removed address falls back to catalog resolution, which pi can do
 * and OpenCode cannot - the user decides what happens to the referencing model
 * instead of the editor silently clearing it.
 */
export function removeDecisionModel(loaded: LoadedConfig, address: string): void {
	const { map } = findDecisionModelNode(loaded, address);
	map.delete(address);
	// An empty map is litter: drop the key so the file reads as if no entry was ever made.
	if (map.items.length === 0) loaded.doc.delete("decisionModels");
}

/** How many configured models name a decision model (the dialogue's confirm/warning text). */
export function countDecisionModelReferences(loaded: LoadedConfig, address: string): number {
	let count = 0;
	for (const item of requireModelsSeq(loaded).items) {
		if (item === null || !isMap(item)) continue;
		if (item.get("decisionModel") === address) count += 1;
	}
	return count;
}

/**
 * Set or clear a model's `idleReset:` option. A duration ("30m", "2h", ...)
 * returns to the head of the fallback list after that much idle time;
 * `classifier` asks the decision model; `null` deletes the key, which is the
 * loader's default (`never`). Validation of the value itself is the loader's
 * job at save time, so an unknown value surfaces with the loader's message.
 */
export function setIdleReset(loaded: LoadedConfig, virtualId: string, option: IdleResetConfig | null): void {
	const { node } = findModelNode(loaded, virtualId);
	if (option === null) {
		node.delete("idleReset");
		return;
	}
	node.set("idleReset", option);
}

/** Set the top-level `debug:` flag (per-switch diagnostics notifications). */
export function setDebug(loaded: LoadedConfig, enabled: boolean): void {
	loaded.doc.set("debug", enabled);
}

/**
 * Validate the mutated document through the loader's single gate and write it
 * atomically. Throws ConfigError (the loader's own messages) when the edited
 * state is not a config `loadConfig()` would accept. On a throw the in-memory
 * document keeps the edit so the dialogue can re-enter the same editor for a fix.
 */
export function saveConfigFile(loaded: LoadedConfig): void {
	if (loaded.doc.contents === undefined || loaded.doc.contents === null) {
		loaded.doc.contents = loaded.doc.createNode({});
	}
	validateFileConfig(loaded.doc.toJSON(), loaded.path);
	try {
		writeFileAtomic(loaded.path, loaded.doc.toString());
	} catch (error) {
		throw new ConfigError(`cannot write config: ${errorMessage(error)}`, loaded.path);
	}
}
