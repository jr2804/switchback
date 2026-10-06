/**
 * Comment-preserving read-modify-write editor for a switchback.yaml layer.
 *
 * Design: `src/config.ts` parses user config with `yaml.parse()`, which
 * keeps values but discards comments - fine for loading, lossy for editing.
 * The interactive dialogue (`src/dialogue.ts`) must round-trip a user's
 * hand-annotated YAML, so this module parses with `parseDocument()` and
 * mutates the Document's nodes in place: existing keys, their order and
 * their comments survive, and only newly created content is synthesized.
 *
 * Validation lives in exactly one place. Every mutation is structural only
 * (locate a node, set/splice/delete); `saveLayer()` re-validates the whole
 * document through the exported `validateFileConfig()` - the same gate the
 * loader applies - and then re-checks every `jev.decisionModel` reference
 * through the exported `resolveJevConfig()`. The editor therefore carries
 * no rule set of its own: a save either produces exactly what `loadConfig()`
 * would accept, or throws the loader's own ConfigError messages.
 *
 * Secrets: API keys never enter the file as literals. The decision-model
 * operations accept a secret NAME (`apiKeySecretName`), and the value is
 * written as `secret:<name>`; storing the value itself is the dialogue's
 * job via the encrypted store (`src/secrets.ts`). The type shape makes a
 * literal key unrepresentable at this boundary.
 *
 * Layers: "project" is `<cwd>/.pi/switchback.yaml`, "global" is
 * `<piConfigDir>/switchback.yaml` (the loader's aggregation order). The
 * dialogue edits one layer file at a time; `defaultLayer()` picks project
 * when a project `.pi/` directory exists, else global.
 *
 * Writes are atomic - tmp file + rename, the `state.ts` pattern - and the
 * parent directory is created on demand, so a first save into a fresh
 * project layer works without ceremony.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMap, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";
import { ConfigError, LOCAL_CLASSIFIER_APIS, piConfigDir, resolveJevConfig, validateFileConfig } from "./config.ts";
import type { DecisionModelEntry, JevConfig, JevRef, ModelId, SwitchbackFileConfig } from "./types.ts";

/** Which switchback.yaml layer the editor has open. */
export type ConfigLayer = "global" | "project";

/** A layer loaded for editing: the parsed Document plus where it lives. */
export interface LoadedLayer {
	layer: ConfigLayer;
	/** Absolute path of the layer file; shown in every dialogue screen title. */
	path: string;
	/** False when the file does not exist yet and the editor started fresh. */
	existed: boolean;
	doc: Document;
}

/** Header comment written when the editor creates a layer file from scratch. */
const NEW_FILE_HEADER = [
	"switchback configuration - see docs/configuration.md",
	"Layers: <cwd>/.pi/switchback.yaml overrides ~/.pi/agent/switchback.yaml per model id.",
	"API keys are secret-store references (`secret:<name>`), never literal values.",
].join("\n");

/** The project layer's file path (`<cwd>/.pi/switchback.yaml`). */
export function projectConfigPath(): string {
	return join(process.cwd(), ".pi", "switchback.yaml");
}

/** The global layer's file path (`<piConfigDir>/switchback.yaml`). */
export function globalConfigPath(): string {
	return join(piConfigDir(), "switchback.yaml");
}

/**
 * The layer a dialogue should open by default: project when the cwd carries
 * a `.pi/` directory (the user keeps per-project overrides there), else global.
 */
export function defaultLayer(): ConfigLayer {
	return existsSync(join(process.cwd(), ".pi")) ? "project" : "global";
}

/** File path for a layer. */
export function layerPath(layer: ConfigLayer): string {
	return layer === "project" ? projectConfigPath() : globalConfigPath();
}

/**
 * Parse a layer for editing. A missing file yields an empty Document that
 * carries the header comment; the first save creates it. A file that is not
 * valid YAML throws ConfigError - the editor opens valid config only, and a
 * broken file is surfaced for a hand fix rather than silently rewritten.
 */
export function loadLayer(layer: ConfigLayer): LoadedLayer {
	const path = layerPath(layer);
	if (!existsSync(path)) {
		const doc = parseDocument("");
		doc.commentBefore = NEW_FILE_HEADER;
		return { layer, path, existed: false, doc };
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
	return { layer, path, existed: true, doc };
}

/**
 * The layer's current config, validated by the loader's own gate. Throws
 * ConfigError when the on-disk document does not satisfy the config rules;
 * the dialogue surfaces that and declines to edit rather than round-tripping
 * an invalid state.
 */
export function readLayerConfig(loaded: LoadedLayer): SwitchbackFileConfig {
	return validateFileConfig(loaded.doc.toJSON(), loaded.path);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The `models:` sequence of a loaded layer; created on demand for a fresh layer file. */
function requireModelsSeq(loaded: LoadedLayer): YAMLSeq {
	const models = loaded.doc.get("models");
	if (models === undefined || models === null) {
		// A fresh layer has no models key yet; the dialogue starts by adding one.
		const created = loaded.doc.createNode([]) as YAMLSeq;
		loaded.doc.set("models", created);
		return created;
	}
	if (!isSeq(models)) throw new ConfigError("models must be an array", loaded.path);
	return models;
}

/** Find a model entry node by virtual-model id; both sides are normalized, so a file storing a bare `auto` is found by `switchback/auto` and vice versa. */
function findModelNode(loaded: LoadedLayer, virtualId: string): { seq: YAMLSeq; index: number; node: YAMLMap } {
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
function assertModelIdAvailable(loaded: LoadedLayer, fullId: string): void {
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
export function addVirtualModel(
	loaded: LoadedLayer,
	input: { id: string; name: string; fallbacks: ModelId[] },
): void {
	const fullId = normalizeVirtualId(input.id);
	assertModelIdAvailable(loaded, fullId);
	const seq = requireModelsSeq(loaded);
	seq.items.push(loaded.doc.createNode({ id: fullId, name: input.name, fallbacks: [...input.fallbacks] }));
}

/** Remove a virtual model entry by id (bare ids normalized). Confirm-gated by the dialogue. */
export function removeVirtualModel(loaded: LoadedLayer, virtualId: string): void {
	const { seq, index } = findModelNode(loaded, virtualId);
	seq.items.splice(index, 1);
}

/** Change a virtual model's id. The running pi keeps the old registration until restart. */
export function renameVirtualModel(loaded: LoadedLayer, oldId: string, newId: string): void {
	const fullNewId = normalizeVirtualId(newId);
	const old = normalizeVirtualId(oldId);
	if (fullNewId !== old) assertModelIdAvailable(loaded, fullNewId);
	const { node } = findModelNode(loaded, oldId);
	node.set("id", fullNewId);
}

/** Change a virtual model's display name. */
export function setVirtualModelName(loaded: LoadedLayer, virtualId: string, name: string): void {
	const { node } = findModelNode(loaded, virtualId);
	node.set("name", name);
}

/** Replace a model's whole fallback list (ordered; first entry is preferred). */
export function setFallbacks(loaded: LoadedLayer, virtualId: string, fallbacks: ModelId[]): void {
	const { node } = findModelNode(loaded, virtualId);
	node.set("fallbacks", loaded.doc.createNode([...fallbacks]));
}

/** Append one fallback at the end of the model's preference list. */
export function addFallback(loaded: LoadedLayer, virtualId: string, fallback: ModelId): void {
	const { node } = findModelNode(loaded, virtualId);
	const seq = node.get("fallbacks");
	if (seq === undefined || seq === null || !isSeq(seq)) {
		throw new ConfigError("fallbacks must be an array", loaded.path);
	}
	seq.items.push(loaded.doc.createNode(fallback));
}

/** Remove the fallback at `index` (bounds-checked; the dialogue passes the picked position). */
export function removeFallback(loaded: LoadedLayer, virtualId: string, index: number): void {
	const { node } = findModelNode(loaded, virtualId);
	const seq = node.get("fallbacks");
	if (seq === undefined || seq === null || !isSeq(seq) || index < 0 || index >= seq.items.length) {
		throw new ConfigError(`fallback index ${index} out of range`, loaded.path);
	}
	seq.items.splice(index, 1);
}

/** Move a fallback from one position to another (the dialogue's up/down reordering). */
export function moveFallback(loaded: LoadedLayer, virtualId: string, from: number, to: number): void {
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
 * Set or clear a model's classifier. `null` clears the key (the model then
 * reports and blind-cycles without classifying), the ref form points at a
 * `decisionModels:` entry by name, and the inline form writes a complete
 * `JevConfig`. Reference validity is enforced at save time through
 * `resolveJevConfig`, so a dangling name fails the save, not the next load.
 */
export function setDecisionModel(
	loaded: LoadedLayer,
	virtualId: string,
	value: JevConfig | { decisionModel: string } | null,
): void {
	const { node } = findModelNode(loaded, virtualId);
	if (value === null) {
		node.delete("jev");
		return;
	}
	node.set("jev", loaded.doc.createNode(value));
}

/** A decision-model entry as the editor accepts it: the apiKey is a secret NAME, never a value. */
export interface DecisionModelInput {
	name: string;
	provider: string;
	id: string;
	baseUrl?: string;
	api?: string;
	/** Stored in YAML as `secret:<name>`; the value itself goes into the encrypted store. */
	apiKeySecretName?: string;
}

/** Field-level patch for an existing decision model; `null` clears an optional field. */
export interface DecisionModelPatch {
	provider?: string;
	id?: string;
	baseUrl?: string | null;
	api?: string | null;
	apiKeySecretName?: string | null;
}

/** A file-level decisionModels entry as the parser produces it. */
type DecisionModelNode = Omit<DecisionModelEntry, "apiKey"> & { apiKey?: string };

function decisionModelToNode(doc: Document, input: DecisionModelInput): YAMLMap {
	const entry: DecisionModelNode = {
		name: input.name,
		provider: input.provider,
		id: input.id,
		...(input.baseUrl !== undefined ? { baseUrl: input.baseUrl } : {}),
		...(input.api !== undefined ? { api: input.api } : {}),
		...(input.apiKeySecretName !== undefined ? { apiKey: `secret:${input.apiKeySecretName}` } : {}),
	};
	return doc.createNode(entry) as YAMLMap;
}

function requireDecisionModelsSeq(loaded: LoadedLayer): YAMLSeq {
	const seq = loaded.doc.get("decisionModels");
	if (seq === undefined || seq === null) {
		const created = loaded.doc.createNode([]) as YAMLSeq;
		loaded.doc.set("decisionModels", created);
		return created;
	}
	if (!isSeq(seq)) throw new ConfigError("decisionModels must be an array", loaded.path);
	return seq;
}

/** Find a decisionModels entry node by name (the reference key). */
function findDecisionModelNode(loaded: LoadedLayer, name: string): { seq: YAMLSeq; index: number; node: YAMLMap } {
	const seq = requireDecisionModelsSeq(loaded);
	for (const [index, item] of seq.items.entries()) {
		if (item === null || !isMap(item)) continue;
		if (item.get("name") === name) return { seq, index, node: item };
	}
	throw new ConfigError(`decisionModel "${name}" not found`, loaded.path);
}

/** Append a decision-model entry (duplicate names fail the save via `validateFileConfig`). */
export function addDecisionModel(loaded: LoadedLayer, input: DecisionModelInput): void {
	const seq = requireDecisionModelsSeq(loaded);
	for (const item of seq.items) {
		if (item !== null && isMap(item) && item.get("name") === input.name) {
			throw new ConfigError(`decisionModels contains the name "${input.name}" more than once`, loaded.path);
		}
	}
	seq.items.push(decisionModelToNode(loaded.doc, input));
}

/** Patch one decision model's fields. `baseUrl: null` also clears `api`/`apiKey` (loader rule: they require baseUrl). */
export function updateDecisionModel(loaded: LoadedLayer, name: string, patch: DecisionModelPatch): void {
	const { node } = findDecisionModelNode(loaded, name);
	if (patch.provider !== undefined) node.set("provider", patch.provider);
	if (patch.id !== undefined) node.set("id", patch.id);
	if (patch.baseUrl !== undefined) {
		if (patch.baseUrl === null) {
			node.delete("baseUrl");
			// api and apiKey are only valid alongside baseUrl; clearing baseUrl clears them.
			node.delete("api");
			node.delete("apiKey");
		} else {
			node.set("baseUrl", patch.baseUrl);
		}
	}
	if (patch.api !== undefined) {
		if (patch.api === null) node.delete("api");
		else node.set("api", patch.api);
	}
	if (patch.apiKeySecretName !== undefined) {
		if (patch.apiKeySecretName === null) node.delete("apiKey");
		else node.set("apiKey", `secret:${patch.apiKeySecretName}`);
	}
}

/**
 * Rename a decision model and rewrite every `jev.decisionModel` reference to
 * it in the same transaction, so a rename cannot dangle references.
 */
export function renameDecisionModel(loaded: LoadedLayer, oldName: string, newName: string): void {
	if (oldName !== newName) {
		const seq = requireDecisionModelsSeq(loaded);
		for (const item of seq.items) {
			if (item !== null && isMap(item) && item.get("name") === newName) {
				throw new ConfigError(`decisionModels contains the name "${newName}" more than once`, loaded.path);
			}
		}
	}
	const { node } = findDecisionModelNode(loaded, oldName);
	node.set("name", newName);
	for (const item of requireModelsSeq(loaded).items) {
		if (item === null || !isMap(item)) continue;
		const jev = item.get("jev");
		if (jev === null || jev === undefined || !isMap(jev)) continue;
		if (jev.get("decisionModel") === oldName) jev.set("decisionModel", newName);
	}
}

/**
 * Remove a decision model. References are NOT rewritten: a model that still
 * names the removed entry fails `saveLayer()` through `resolveJevConfig` with
 * the loader's actionable message, so the user decides what happens to the
 * referencing model instead of the editor silently clearing it.
 */
export function removeDecisionModel(loaded: LoadedLayer, name: string): void {
	const { seq, index } = findDecisionModelNode(loaded, name);
	seq.items.splice(index, 1);
}

/** How many configured models reference a decision model (the dialogue's confirm/warning text). */
export function countDecisionModelReferences(loaded: LoadedLayer, name: string): number {
	let count = 0;
	for (const item of requireModelsSeq(loaded).items) {
		if (item === null || !isMap(item)) continue;
		const jev = item.get("jev");
		if (jev === null || jev === undefined || !isMap(jev)) continue;
		if (jev.get("decisionModel") === name) count += 1;
	}
	return count;
}

/** Set the top-level `debug:` flag (per-switch diagnostics notifications). */
export function setDebug(loaded: LoadedLayer, enabled: boolean): void {
	loaded.doc.set("debug", enabled);
}

/**
 * Validate the mutated document through the loader's single gate and write it
 * atomically. Throws ConfigError (the loader's own messages) when the edited
 * state is not a config `loadConfig()` would accept - including dangling
 * `jev.decisionModel` references, checked here through the exported
 * `resolveJevConfig`. On a throw the in-memory document keeps the edit so the
 * dialogue can re-enter the same editor for a fix.
 */
export function saveLayer(loaded: LoadedLayer): void {
	if (loaded.doc.contents === undefined || loaded.doc.contents === null) {
		loaded.doc.contents = loaded.doc.createNode({});
	}
	const parsed = validateFileConfig(loaded.doc.toJSON(), loaded.path);
	for (const model of parsed.models) {
		resolveJevConfig(parsed.decisionModels, model.jev as JevRef | undefined);
	}
	mkdirSync(dirname(loaded.path), { recursive: true });
	const tmp = `${loaded.path}.tmp`;
	try {
		writeFileSync(tmp, loaded.doc.toString(), "utf8");
		renameSync(tmp, loaded.path);
	} catch (error) {
		throw new ConfigError(`cannot write config: ${errorMessage(error)}`, loaded.path);
	}
}

/** The wire APIs a direct-endpoint decision model may use (re-exported for the dialogue menu). */
export { LOCAL_CLASSIFIER_APIS };
