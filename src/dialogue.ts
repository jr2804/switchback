/**
 * Interactive `/switchback-config` dialogue: an edit loop over one
 * switchback.yaml layer, built on pi's built-in dialogs (`ctx.ui.select`,
 * `confirm`, `input`, `notify`).
 *
 * Design: every mutation goes through `src/config-editor.ts` and is saved
 * immediately (`saveLayer`). The file on disk therefore always holds the
 * last good config, which makes failure handling trivial: when a save
 * throws the loader's own ConfigError, the dialogue reports it and reloads
 * the layer from disk - exactly the failed action is reverted, nothing else.
 * No undo bookkeeping, and the document in memory never drifts from a valid
 * state for longer than one action.
 *
 * The dialogue is deliberately thin: it owns prompt/confirm flow and error
 * reporting only. All rules live in the loader (single validator), all file
 * mutation lives in the editor, all secret material lives in the encrypted
 * store - a literal API key is unrepresentable here because the editor only
 * accepts a secret NAME and the value goes straight into the store.
 *
 * UI surface: structural types (`DialogueContext`) instead of pi's command
 * context type. The real command context is assignable to the structural
 * shape, tests can mock it without a TUI, and this module keeps a bare
 * import surface (install-safe: no host-package imports at all).
 *
 * Screen titles always carry the file path being edited, so it is always
 * obvious which layer - project or global - a change lands in.
 */

import {
	addDecisionModel,
	addFallback,
	addVirtualModel,
	countDecisionModelReferences,
	defaultLayer,
	globalConfigPath,
	layerExists,
	loadLayer,
	moveFallback,
	projectConfigPath,
	readLayerConfig,
	removeDecisionModel,
	removeFallback,
	removeVirtualModel,
	renameDecisionModel,
	renameVirtualModel,
	saveLayer,
	setDecisionModel,
	setDebug,
	setVirtualModelName,
	updateDecisionModel,
	type ConfigLayer,
	type DecisionModelInput,
	type DecisionModelPatch,
	type LoadedLayer,
} from "./config-editor.ts";
import { LOCAL_CLASSIFIER_APIS } from "./config.ts";
import { createSecretStore, type SecretStore } from "./secrets.ts";
import type { DecisionModelEntry, JevConfig, JevRef, SwitchbackConfig, SwitchbackFileConfig } from "./types.ts";

/** The dialog surface the dialogue needs (a subset of pi's `ctx.ui`). */
export interface DialogueUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

/** The command context the dialogue runs in (structurally satisfied by pi's context). */
export interface DialogueContext {
	hasUI: boolean;
	ui: DialogueUi;
}

interface DialogueSession {
	loaded: LoadedLayer;
	secrets: SecretStore;
}

/** Describe a model's classifier for menus: reference, inline, or none. */
export function describeJev(jev: JevRef | undefined): string {
	if (jev === undefined) return "(none - report and cycle)";
	if ("decisionModel" in jev) return `decision model "${jev.decisionModel}"`;
	const direct = jev.baseUrl !== undefined ? ` (direct: ${jev.baseUrl})` : "";
	return `${jev.provider}/${jev.id}${direct}`;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function screenTitle(loaded: LoadedLayer, body: string): string {
	const fresh = loaded.existed ? "" : " (new file)";
	return `[${loaded.layer} layer: ${loaded.path}${fresh}]\n${body}`;
}

/**
 * Label for one layer in the chooser: which file, and what is in it right now.
 * Paths live in the screen title, so a label stays stable and scriptable.
 */
export function layerOptionLabel(layer: ConfigLayer): string {
	const name = layer === "global" ? "Global" : "Project";
	return `${name} - ${describeLayerState(layer)}`;
}

/** "not present", "N model(s)" or "unreadable (invalid config)" for a layer. */
function describeLayerState(layer: ConfigLayer): string {
	if (!layerExists(layer)) return "not present";
	try {
		const models = readLayerConfig(loadLayer(layer)).models.length;
		return `${models} model${models === 1 ? "" : "s"}`;
	} catch {
		return "unreadable (invalid config)";
	}
}

/**
 * Ask which layer to edit.
 *
 * This is the dialogue's first prompt, and the target of "Switch layer...",
 * because the layer changes what every later action means: project entries
 * override global entries with the same model id, so writing to the wrong file
 * either shadows the other config or fails to. The chooser shows both files,
 * what each currently holds, and which one is being edited; the preferred layer
 * is offered first (Enter keeps it). Esc cancels the dialogue.
 */
async function selectLayer(ctx: DialogueContext, current: ConfigLayer | undefined): Promise<ConfigLayer | undefined> {
	const preferred = current ?? defaultLayer();
	const labels: Record<ConfigLayer, string> = {
		global: layerOptionLabel("global"),
		project: layerOptionLabel("project"),
	};
	const order: ConfigLayer[] = preferred === "global" ? ["global", "project"] : ["project", "global"];
	const title = [
		current === undefined ? "which config layer do you want to edit?" : `switch layer (currently: ${current})`,
		`  global:  ${globalConfigPath()}`,
		`  project: ${projectConfigPath()}`,
		"Project entries override global entries with the same model id.",
	].join("\n");
	const choice = await ctx.ui.select(title, order.map((layer) => labels[layer]));
	if (choice === undefined) return undefined;
	return choice === labels["global"] ? "global" : "project";
}

/**
 * Run the dialogue. Returns when the user is done; every completed action has
 * already been saved to the layer file by then.
 */
export async function runDialogue(ctx: DialogueContext, store?: SecretStore): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/switchback-config needs a UI-capable context (TUI or RPC)", "warning");
		return;
	}
	const secrets = store ?? createSecretStore();
	const chosen = await selectLayer(ctx, undefined);
	if (chosen === undefined) return;
	let layer: ConfigLayer = chosen;
	for (;;) {
		const loaded = openLayer(ctx, layer);
		if (loaded === undefined) return;
		const session: DialogueSession = { loaded, secrets };
		const outcome = await mainMenu(ctx, session);
		if (outcome === "done") return;
		const next = await selectLayer(ctx, loaded.layer);
		if (next === undefined) return;
		layer = next;
	}
}

/** Load a layer for editing; a read or YAML failure is reported and ends the dialogue. */
function openLayer(ctx: DialogueContext, layer: ConfigLayer): LoadedLayer | undefined {
	try {
		return loadLayer(layer);
	} catch (error) {
		ctx.ui.notify(`cannot open ${layer} layer: ${errorMessage(error)}`, "error");
		return undefined;
	}
}

/**
 * The validated config snapshot for menus; a file that fails the loader's
 * rules is reported (with the fix hint) and ends the dialogue - the editor
 * only round-trips config the loader itself accepts.
 */
function readConfigOrReport(ctx: DialogueContext, loaded: LoadedLayer): SwitchbackFileConfig | undefined {
	try {
		return readLayerConfig(loaded);
	} catch (error) {
		ctx.ui.notify(
			`${errorMessage(error)}\nThe editor only opens valid config; fix switchback.yaml by hand and retry.`,
			"error",
		);
		return undefined;
	}
}

/**
 * Save and report success; on a ConfigError, report the loader's message and
 * reload the layer from disk so exactly the failed action is reverted (the
 * file on disk always holds the last good config). Returns true when saved.
 */
async function saveOrRevert(ctx: DialogueContext, session: DialogueSession): Promise<boolean> {
	try {
		saveLayer(session.loaded);
		return true;
	} catch (error) {
		ctx.ui.notify(
			`${screenTitle(session.loaded, "not saved")}\n${errorMessage(error)}\nThe change was reverted - the file on disk is unchanged.`,
			"error",
		);
		try {
			session.loaded = loadLayer(session.loaded.layer);
		} catch (reloadError) {
			ctx.ui.notify(`cannot reload layer after failed save: ${errorMessage(reloadError)}`, "error");
		}
		return false;
	}
}

/**
 * The validated config snapshot, or undefined when the layer has no content
 * yet (fresh file) - callers treat undefined as "nothing to clash with"; the
 * save gate still validates everything that ends up in the file.
 */
function tryReadConfig(loaded: LoadedLayer): SwitchbackFileConfig | undefined {
	try {
		return readLayerConfig(loaded);
	} catch {
		return undefined;
	}
}

/** Required single-line input: Esc aborts the step, empty input re-prompts. */
async function promptRequired(ctx: DialogueContext, title: string, placeholder: string): Promise<string | undefined> {
	for (;;) {
		const value = await ctx.ui.input(title, placeholder);
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		if (trimmed.length > 0) return trimmed;
		ctx.ui.notify("a value is required (Esc leaves the step)", "warning");
	}
}

/** Optional single-line input: Esc = keep (undefined), empty = clear (null), text = set. */
async function promptOptional(
	ctx: DialogueContext,
	title: string,
	current: string | undefined,
): Promise<string | null | undefined> {
	const shown = current !== undefined && current.length > 0 ? ` (current: ${current})` : " (not set)";
	const value = await ctx.ui.input(`${title}${shown} - empty clears, Esc keeps`, "value");
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	return trimmed.length === 0 ? null : trimmed;
}

type MainOutcome = "done" | "switch";

async function mainMenu(ctx: DialogueContext, session: DialogueSession): Promise<MainOutcome> {
	for (;;) {
		// A layer with no content yet (first save) has no valid config to read;
		// offer the reduced menu until the first virtual model exists.
		if (session.loaded.doc.contents === undefined || session.loaded.doc.contents === null) {
			const choice = await ctx.ui.select(
				screenTitle(session.loaded, "no config in this layer yet"),
				["Add virtual model...", "Switch layer...", "Done"],
			);
			if (choice === undefined || choice === "Done") return "done";
			if (choice.startsWith("Switch layer")) return "switch";
			await addVirtualModelWizard(ctx, session);
			continue;
		}
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return "done";
		const options: string[] = config.models.map((m) => `${m.id} - ${m.name}`);
		const addOption = "Add virtual model...";
		const debugOption = `Toggle debug (currently ${config.debug === true ? "on" : "off"})`;
		const dmOption = `Decision models (${config.decisionModels?.length ?? 0})...`;
		const switchOption = "Switch layer...";
		const doneOption = "Done";
		options.push(addOption, debugOption, dmOption, switchOption, doneOption);

		const choice = await ctx.ui.select(screenTitle(session.loaded, "switchback configuration"), options);
		if (choice === undefined || choice === doneOption) return "done";
		if (choice === switchOption) return "switch";
		if (choice === debugOption) {
			await toggleDebug(ctx, session, config);
			continue;
		}
		if (choice === dmOption) {
			await decisionModelsMenu(ctx, session);
			continue;
		}
		if (choice === addOption) {
			await addVirtualModelWizard(ctx, session);
			continue;
		}
		const model = config.models.find((m) => `${m.id} - ${m.name}` === choice);
		if (model !== undefined) await virtualModelMenu(ctx, session, model);
	}
}

async function toggleDebug(ctx: DialogueContext, session: DialogueSession, config: SwitchbackFileConfig): Promise<void> {
	const next = !(config.debug === true);
	setDebug(session.loaded, next);
	if (await saveOrRevert(ctx, session)) {
		ctx.ui.notify(`debug ${next ? "on" : "off"} - saved to ${session.loaded.path}`, "info");
	}
}

function findModel(config: SwitchbackFileConfig, id: string): SwitchbackConfig | undefined {
	return config.models.find((m) => m.id === id);
}

async function virtualModelMenu(ctx: DialogueContext, session: DialogueSession, model: SwitchbackConfig): Promise<void> {
	const renameIdOption = "Rename model id (pi restart required)";
	const renameNameOption = "Change display name";
	const editFallbacks = (n: number): string => `Edit fallbacks (${n})`;
	const decisionOption = (config: SwitchbackConfig): string => `Decision model: ${describeJev(config.jev)}`;
	const removeOption = "Remove model";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const current = findModel(config, model.id);
		if (current === undefined) return; // removed elsewhere in this session
		const fallbacksOption = editFallbacks(current.fallbacks.length);
		const decisionLabel = decisionOption(current);
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, `${current.id} - ${current.name}`),
			[renameIdOption, renameNameOption, fallbacksOption, decisionLabel, removeOption, backOption],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === renameIdOption) {
			const newId = await promptRequired(
				ctx,
				screenTitle(session.loaded, `rename ${current.id} - new model id (bare "auto" becomes "switchback/auto")`),
				current.id,
			);
			if (newId === undefined) continue;
			renameVirtualModel(session.loaded, current.id, newId);
			if (await saveOrRevert(ctx, session)) {
				model.id = newId;
				ctx.ui.notify(
					`renamed to ${newId} - the running pi keeps the old id until restart`,
					"info",
				);
			}
			continue;
		}
		if (choice === renameNameOption) {
			const newName = await promptRequired(
				ctx,
				screenTitle(session.loaded, `display name for ${current.id}`),
				current.name,
			);
			if (newName === undefined) continue;
			setVirtualModelName(session.loaded, current.id, newName);
			if (await saveOrRevert(ctx, session)) model.name = newName;
			continue;
		}
		if (choice === fallbacksOption) {
			await fallbacksEditor(ctx, session, current.id);
			continue;
		}
		if (choice === decisionLabel) {
			await decisionModelPicker(ctx, session, current.id);
			continue;
		}
		if (choice === removeOption) {
			const configNow = readConfigOrReport(ctx, session.loaded);
			if (configNow === undefined) return;
			if (configNow.models.length <= 1) {
				ctx.ui.notify("the last virtual model cannot be removed - add another one first", "warning");
				continue;
			}
			const confirmed = await ctx.ui.confirm(
				screenTitle(session.loaded, `remove ${current.id}`),
				`Remove ${current.id} and its ${current.fallbacks.length} fallback(s) from ${session.loaded.path}?`,
			);
			if (!confirmed) continue;
			removeVirtualModel(session.loaded, current.id);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`removed ${current.id}`, "info");
				return;
			}
		}
	}
}

async function fallbacksEditor(ctx: DialogueContext, session: DialogueSession, virtualId: string): Promise<void> {
	const addOption = "Add fallback...";
	const removeOption = "Remove fallback...";
	const upOption = "Move up...";
	const downOption = "Move down...";
	const doneOption = "Done";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const model = findModel(config, virtualId);
		if (model === undefined) return;
		const body = ["Fallbacks (first = preferred):", ...model.fallbacks.map((f, i) => `  ${i + 1}. ${f}`)].join("\n");
		const choice = await ctx.ui.select(screenTitle(session.loaded, body), [
			addOption,
			removeOption,
			upOption,
			downOption,
			doneOption,
		]);
		if (choice === undefined || choice === doneOption) return;
		const labels = model.fallbacks.map((f, i) => `${i + 1}. ${f}`);
		if (choice === addOption) {
			const fallback = await promptRequired(
				ctx,
				screenTitle(session.loaded, `add fallback to ${virtualId} ("provider/id")`),
				"provider/id",
			);
			if (fallback === undefined) continue;
			addFallback(session.loaded, virtualId, fallback);
			await saveOrRevert(ctx, session);
			continue;
		}
		if (choice === removeOption) {
			if (model.fallbacks.length <= 1) {
				ctx.ui.notify("at least one fallback is required - add one before removing the last", "warning");
				continue;
			}
			const target = await ctx.ui.select(screenTitle(session.loaded, "remove which fallback?"), labels);
			const index = target === undefined ? -1 : labels.indexOf(target);
			if (index < 0) continue;
			removeFallback(session.loaded, virtualId, index);
			await saveOrRevert(ctx, session);
			continue;
		}
		if (choice === upOption || choice === downOption) {
			const up = choice === upOption;
			const candidates = model.fallbacks
				.map((f, i) => ({ label: `${i + 1}. ${f}`, index: i }))
				.filter((e) => (up ? e.index > 0 : e.index < model.fallbacks.length - 1));
			if (candidates.length === 0) {
				ctx.ui.notify(`that fallback list has nothing to move ${up ? "up" : "down"}`, "warning");
				continue;
			}
			const target = await ctx.ui.select(
				screenTitle(session.loaded, `move which fallback ${up ? "up" : "down"}?`),
				candidates.map((e) => e.label),
			);
			const picked = target === undefined ? undefined : candidates.find((e) => e.label === target);
			if (picked === undefined) continue;
			moveFallback(session.loaded, virtualId, picked.index, up ? picked.index - 1 : picked.index + 1);
			await saveOrRevert(ctx, session);
		}
	}
}

async function decisionModelPicker(ctx: DialogueContext, session: DialogueSession, virtualId: string): Promise<void> {
	const noneOption = "(none - report and cycle)";
	const inlineOption = "(inline - configure directly)...";
	const newOption = "New decision model...";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const model = findModel(config, virtualId);
		if (model === undefined) return;
		const dmLabels = (config.decisionModels ?? []).map((d) => `${d.name} - ${d.provider}/${d.id}`);
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, `decision model for ${virtualId}\ncurrently: ${describeJev(model.jev)}`),
			[noneOption, ...dmLabels, inlineOption, newOption, backOption],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === noneOption) {
			setDecisionModel(session.loaded, virtualId, null);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: classifier cleared (reports and cycles)`, "info");
				return;
			}
			continue;
		}
		if (choice === inlineOption) {
			const existing = model.jev !== undefined && !("decisionModel" in model.jev) ? model.jev : undefined;
			const inline = await collectJevFields(ctx, session, existing);
			if (inline === undefined) continue;
			setDecisionModel(session.loaded, virtualId, inline);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: inline classifier set`, "info");
				return;
			}
			continue;
		}
		if (choice === newOption) {
			const created = await decisionModelWizard(ctx, session);
			if (created === undefined) continue;
			setDecisionModel(session.loaded, virtualId, { decisionModel: created.name });
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: decision model "${created.name}" created and set`, "info");
				return;
			}
			continue;
		}
		const name = dmLabels.indexOf(choice) >= 0 ? (config.decisionModels ?? [])[dmLabels.indexOf(choice)]?.name : undefined;
		const entry = name !== undefined ? (config.decisionModels ?? []).find((d) => d.name === name) : undefined;
		if (entry === undefined) continue;
		setDecisionModel(session.loaded, virtualId, { decisionModel: entry.name });
		if (await saveOrRevert(ctx, session)) {
			ctx.ui.notify(`${virtualId}: decision model "${entry.name}" set`, "info");
			return;
		}
	}
}

async function decisionModelsMenu(ctx: DialogueContext, session: DialogueSession): Promise<void> {
	const addOption = "Add decision model...";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const entries = config.decisionModels ?? [];
		const labels = entries.map((d) => `${d.name} - ${d.provider}/${d.id}`);
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, "decision models (reusable classifier configs)"),
			[...labels, addOption, backOption],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === addOption) {
			await decisionModelWizard(ctx, session);
			continue;
		}
		const name = labels.indexOf(choice) >= 0 ? entries[labels.indexOf(choice)]?.name : undefined;
		const entry = name !== undefined ? entries.find((d) => d.name === name) : undefined;
		if (entry !== undefined) await decisionModelEntryMenu(ctx, session, entry);
	}
}

async function decisionModelEntryMenu(
	ctx: DialogueContext,
	session: DialogueSession,
	entry: DecisionModelEntry,
): Promise<void> {
	const renameOption = "Rename (updates references)";
	const editOption = "Edit fields";
	const deleteOption = "Delete";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const current = (config.decisionModels ?? []).find((d) => d.name === entry.name);
		if (current === undefined) return; // deleted elsewhere in this session
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, `${current.name} - ${current.provider}/${current.id}`),
			[renameOption, editOption, deleteOption, backOption],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === renameOption) {
			const newName = await promptRequired(
				ctx,
				screenTitle(session.loaded, `rename decision model "${current.name}"`),
				current.name,
			);
			if (newName === undefined || newName === current.name) continue;
			renameDecisionModel(session.loaded, current.name, newName);
			if (await saveOrRevert(ctx, session)) {
				entry.name = newName;
				ctx.ui.notify(`renamed to "${newName}"; references updated`, "info");
			}
			continue;
		}
		if (choice === editOption) {
			const patch = await collectJevPatch(ctx, session, current);
			if (patch === undefined) continue;
			updateDecisionModel(session.loaded, current.name, patch);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`decision model "${current.name}" updated`, "info");
			}
			continue;
		}
		if (choice === deleteOption) {
			const refs = countDecisionModelReferences(session.loaded, current.name);
			if (refs > 0) {
				ctx.ui.notify(
					`"${current.name}" is still referenced by ${refs} model(s) - set their decision model first`,
					"warning",
				);
				continue;
			}
			const confirmed = await ctx.ui.confirm(
				screenTitle(session.loaded, `delete decision model "${current.name}"`),
				`Delete "${current.name}" (${current.provider}/${current.id}) from ${session.loaded.path}?`,
			);
			if (!confirmed) continue;
			removeDecisionModel(session.loaded, current.name);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`deleted "${current.name}"`, "info");
				return;
			}
		}
	}
}

/** Collect a brand-new decision model entry (name first, then classifier fields). */
async function decisionModelWizard(ctx: DialogueContext, session: DialogueSession): Promise<DecisionModelInput | undefined> {
	// Tolerant read: on a fresh layer there is no config yet and no name to clash with;
	// addDecisionModel + the save gate still own the uniqueness rule.
	const config = tryReadConfig(session.loaded);
	const name = await promptRequired(ctx, screenTitle(session.loaded, "new decision model - name"), "e.g. local-jev");
	if (name === undefined) return undefined;
	if ((config?.decisionModels ?? []).some((d) => d.name === name)) {
		ctx.ui.notify(`a decision model named "${name}" already exists`, "warning");
		return undefined;
	}
	const fields = await collectJevFields(ctx, session, undefined);
	if (fields === undefined) return undefined;
	const input: DecisionModelInput = { name, provider: fields.provider, id: fields.id, ...(fields.rest ?? {}) };
	try {
		addDecisionModel(session.loaded, input);
	} catch (error) {
		ctx.ui.notify(errorMessage(error), "warning");
		return undefined;
	}
	if (await saveOrRevert(ctx, session)) {
		ctx.ui.notify(`decision model "${name}" added`, "info");
		return input;
	}
	return undefined;
}

/** Classifier fields for a NEW inline config / decision model. Undefined = user backed out. */
async function collectJevFields(
	ctx: DialogueContext,
	session: DialogueSession,
	existing: JevConfig | undefined,
): Promise<{ provider: string; id: string; rest?: Partial<DecisionModelInput> } | undefined> {
	const provider = await promptRequired(
		ctx,
		screenTitle(session.loaded, "classifier provider (e.g. typesafe, ollama)"),
		existing?.provider ?? "",
	);
	if (provider === undefined) return undefined;
	const id = await promptRequired(ctx, screenTitle(session.loaded, "classifier model id"), existing?.id ?? "");
	if (id === undefined) return undefined;
	const baseUrl = await promptOptional(ctx, "baseUrl - direct endpoint (enables a local SystemOne server)", existing?.baseUrl);
	if (baseUrl === undefined) return undefined;
	if (baseUrl === null) return { provider, id };
	const api = await ctx.ui.select(
		screenTitle(session.loaded, "wire API for the direct endpoint"),
		["(none)", ...LOCAL_CLASSIFIER_APIS],
	);
	if (api === undefined) return undefined;
	const rest: Partial<DecisionModelInput> = { baseUrl };
	if (api !== "(none)") rest.api = api;
	const keyAction = await apiKeyAction(ctx, session, existing?.apiKey);
	if (keyAction === undefined) return undefined;
	if (keyAction !== null) rest.apiKeySecretName = keyAction;
	return { provider, id, rest };
}

/** Patch fields for an EXISTING decision model. Undefined = user backed out. */
async function collectJevPatch(
	ctx: DialogueContext,
	session: DialogueSession,
	current: DecisionModelEntry,
): Promise<DecisionModelPatch | undefined> {
	const provider = await promptOptional(ctx, "provider", current.provider);
	if (provider === undefined) return undefined;
	const id = await promptOptional(ctx, "model id", current.id);
	if (id === undefined) return undefined;
	const patch: DecisionModelPatch = {};
	if (provider !== null) patch.provider = provider;
	if (id !== null) patch.id = id;
	const baseUrl = await promptOptional(ctx, "baseUrl - direct endpoint", current.baseUrl);
	if (baseUrl === undefined) return undefined;
	if (baseUrl === null) {
		// updateDecisionModel clears api/apiKey with baseUrl (loader rule: they require it).
		patch.baseUrl = null;
		return patch;
	}
	patch.baseUrl = baseUrl;
	const api = await ctx.ui.select(
		screenTitle(session.loaded, "wire API for the direct endpoint"),
		["(none)", ...LOCAL_CLASSIFIER_APIS],
	);
	if (api === undefined) return undefined;
	patch.api = api === "(none)" ? null : api;
	const keyAction = await apiKeyAction(ctx, session, current.apiKey);
	if (keyAction === undefined) return undefined;
	patch.apiKeySecretName = keyAction; // null removes the key
	return patch;
}

/**
 * Ask what to do about the API key. Returns the secret NAME to reference
 * (after storing the value), null to remove the key, or undefined when the
 * user backed out or chose to keep the current state.
 */
async function apiKeyAction(
	ctx: DialogueContext,
	session: DialogueSession,
	current: string | undefined,
): Promise<string | null | undefined> {
	const keepLabel =
		current !== undefined ? `Keep current (${current.startsWith("secret:") ? current : "value set by hand"})` : "(no API key)";
	const keepOption = current !== undefined ? keepLabel : "(no API key)";
	const existingOption = "Use existing secret...";
	const newOption = "New secret...";
	const removeOption = "Remove API key";
	const choice = await ctx.ui.select(
		screenTitle(session.loaded, "API key - stored encrypted; the config only carries secret:<name>"),
		current === undefined ? [keepOption, existingOption, newOption] : [keepOption, existingOption, newOption, removeOption],
	);
	if (choice === undefined || choice === keepOption) return undefined;
	if (choice === removeOption) return null;
	if (choice === existingOption) {
		const names = session.secrets.list();
		if (names.length === 0) {
			ctx.ui.notify("no secrets stored yet - pick 'New secret...'", "warning");
			return undefined;
		}
		const name = await ctx.ui.select(screenTitle(session.loaded, "reference which stored secret?"), [...names]);
		return name;
	}
	const name = await promptRequired(ctx, screenTitle(session.loaded, "new secret - name"), "e.g. ollama-key");
	if (name === undefined) return undefined;
	const value = await promptRequired(
		ctx,
		screenTitle(session.loaded, `value for secret "${name}" (stored encrypted, not shown again)`),
		"secret value",
	);
	if (value === undefined) return undefined;
	try {
		session.secrets.set(name, value);
	} catch (error) {
		ctx.ui.notify(`secret store refused the value: ${errorMessage(error)}`, "error");
		return undefined;
	}
	return name;
}

/** Wizard: create a new virtual model entry (id, name, at least one fallback). */
async function addVirtualModelWizard(ctx: DialogueContext, session: DialogueSession): Promise<void> {
	const id = await promptRequired(
		ctx,
		screenTitle(session.loaded, 'new virtual model - id (bare "auto" becomes "switchback/auto")'),
		"auto",
	);
	if (id === undefined) return;
	const name = await promptRequired(ctx, screenTitle(session.loaded, `display name for ${id}`), "e.g. Auto (fast)");
	if (name === undefined) return;
	const fallbacks: string[] = [];
	const addOption = "Add fallback...";
	const doneOption = "Done (needs at least one)";
	for (;;) {
		const body = [
			"Fallbacks for the new model (first = preferred):",
			...(fallbacks.length === 0 ? ["  (none yet)"] : fallbacks.map((f, i) => `  ${i + 1}. ${f}`)),
		].join("\n");
		const choice = await ctx.ui.select(screenTitle(session.loaded, body), [addOption, doneOption]);
		if (choice === undefined) return;
		if (choice === addOption) {
			const fallback = await promptRequired(
				ctx,
				screenTitle(session.loaded, `fallback ${fallbacks.length + 1} ("provider/id")`),
				"provider/id",
			);
			if (fallback !== undefined) fallbacks.push(fallback);
			continue;
		}
		if (fallbacks.length === 0) {
			ctx.ui.notify("at least one fallback is required - add one first", "warning");
			continue;
		}
		break;
	}
	try {
		addVirtualModel(session.loaded, { id, name, fallbacks });
	} catch (error) {
		ctx.ui.notify(errorMessage(error), "warning");
		return;
	}
	if (await saveOrRevert(ctx, session)) {
		ctx.ui.notify(`${id} added with ${fallbacks.length} fallback(s) - use its menu to attach a decision model`, "info");
	}
}
