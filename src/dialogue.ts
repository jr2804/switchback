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
import { classifierBaseUrlNote, defaultDecisionModelName, directEndpointWouldClobber, type ClassifierProviderOption } from "./classifier-catalog.ts";
import { discoverOllamaModels } from "./classifier-discovery.ts";
import { formatProbeReport, type ProbeResult } from "./classifier-probe.ts";
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
	/**
	 * Optional searchable model picker (TUI contexts supply it). When present,
	 * "Add fallback..." opens a fuzzy-searchable catalog list instead of asking for
	 * `provider/id` from memory; when absent the dialogue falls back to the prompt.
	 */
	pickModel?: (title: string, current: readonly string[]) => Promise<string | undefined>;
	/**
	 * Classifier endpoints pi knows about, for the decision-model wizard's provider
	 * choice and base-URL defaults (see `src/classifier-catalog.ts`). Empty or
	 * absent falls back to free-text prompts.
	 */
	classifierProviders?: readonly ClassifierProviderOption[];
	/**
	 * Send the one-shot capability prompt (choice + score + noul) to a configured
	 * decision model. Supplied by the command handler, which has the model registry
	 * and switchback's transport; absent means the test is not offered.
	 */
	probeClassifier?: (jev: JevConfig) => Promise<ProbeResult>;
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

/**
 * Ask for one physical model. With a TUI picker available the catalog is
 * searchable (the `/model` experience); otherwise the user types `provider/id`.
 */
async function chooseFallback(
	ctx: DialogueContext,
	session: DialogueSession,
	title: string,
	current: readonly string[],
): Promise<string | undefined> {
	if (ctx.pickModel !== undefined) return ctx.pickModel(title, current);
	return promptRequired(ctx, title, "provider/id");
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

/**
 * Name-last step of the decision-model wizard: the input arrives prefilled with
 * a derived default, empty input keeps the default, Esc aborts. A name already
 * in use is rejected with a warning and the prompt loops.
 */
async function promptNameLast(
	ctx: DialogueContext,
	loaded: LoadedLayer,
	suggestedName: string,
	knownNames: readonly string[],
): Promise<string | undefined> {
	for (;;) {
		const value = await ctx.ui.input(
			screenTitle(loaded, `new decision model - name (Enter keeps "${suggestedName}")`),
			suggestedName,
		);
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		const name = trimmed.length === 0 ? suggestedName : trimmed;
		if (knownNames.includes(name)) {
			ctx.ui.notify(`a decision model named "${name}" already exists`, "warning");
			continue;
		}
		return name;
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
			const fallback = await chooseFallback(
				ctx,
				session,
				screenTitle(session.loaded, `add fallback to ${virtualId} ("provider/id")`),
				model.fallbacks,
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
			const inline = await collectJevFields(ctx, session, existing, virtualId);
			if (inline === undefined) continue;
			setDecisionModel(session.loaded, virtualId, inline);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: inline classifier set`, "info");
				await offerClassifierTest(ctx, session, jevFromInput(inline));
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
	const testOption = "Test classifier (choice, score, noul)";
	const deleteOption = "Delete";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const current = (config.decisionModels ?? []).find((d) => d.name === entry.name);
		if (current === undefined) return; // deleted elsewhere in this session
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, `${current.name} - ${current.provider}/${current.id}`),
			[
				renameOption,
				editOption,
				...(ctx.probeClassifier !== undefined ? [testOption] : []),
				deleteOption,
				backOption,
			],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === testOption) {
			await runClassifierTest(ctx, session, {
				provider: current.provider,
				id: current.id,
				...(current.baseUrl !== undefined ? { baseUrl: current.baseUrl } : {}),
				...(current.api !== undefined ? { api: current.api } : {}),
				...(current.apiKey !== undefined ? { apiKey: current.apiKey } : {}),
			});
			continue;
		}
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

/** Collect a brand-new decision model entry. The order is provider → baseUrl →
 * model id → apiKey → name (last, prefilled). The user can Tab + Enter through
 * the whole flow when accepting the defaults; the only prompt that requires a
 * real decision is the apiKey action (new secret, keep existing, or none).
 */
async function decisionModelWizard(ctx: DialogueContext, session: DialogueSession): Promise<DecisionModelInput | undefined> {
	// Tolerant read: on a fresh layer there is no config yet and no name to clash with;
	// addDecisionModel + the save gate still own the uniqueness rule.
	const config = tryReadConfig(session.loaded);
	const knownNames = (config?.decisionModels ?? []).map((d) => d.name);

	// 1. Provider
	const option = await chooseClassifierProvider(ctx, session, undefined);
	if (option === undefined) return undefined;

	// 2. baseUrl (always prefilled for both catalog and local; "-" clears it)
	const baseUrl = await chooseBaseUrl(ctx, session, option, undefined);
	if (baseUrl === undefined) return undefined;

	// 3. Model id (from the provider's catalog classifiers, or asked of the endpoint itself)
	const id = await chooseClassifierModel(ctx, session, option, undefined, baseUrl ?? option.baseUrl);
	if (id === undefined) return undefined;

	// apiKey / api / baseUrl are loader-coupled: apiKey and api both require a
	// baseUrl, so a cleared baseUrl means none of those fields apply. Skip the
	// apiKey step entirely when the user typed "-".
	let apiKeyResult: ApiKeyAction = { kind: "none" };
	if (baseUrl !== null) {
		// 4. apiKey action: collect the user's choice (none / pick existing / new
		//    secret value) but defer the secret-store write until we know the
		//    final decision-model name - the store entry is derived from the
		//    name so a single secret can be re-keyed under the new name.
		apiKeyResult = await apiKeyAction(ctx, session, undefined, option.provider);
		if (apiKeyResult.kind === "cancel") return undefined;
	}

	// 5. Name (LAST, prefilled). Only the catalog providers need an apiKey at
	//    all - a local Ollama / llama-server ignores it; a local server also
	//    needs one as a non-empty transport requirement, but the wizard sets
	//    it for them when the user picks "no api key" or skips the step.
	const rest: Partial<DecisionModelInput> = {};
	if (baseUrl !== null && baseUrl !== undefined) rest.baseUrl = baseUrl;
	if (baseUrl !== null && baseUrl !== undefined) {
		const api = option.api ?? LOCAL_CLASSIFIER_APIS[0];
		if (api !== undefined) rest.api = api;
	}
	if (apiKeyResult.kind === "secret") {
		// Defer the secret-store commit until the name is known so the store
		// entry follows the decision-model name (`secret:<name>-key`); we pass
		// apiKeyResult.value into the new logic further below.
	}
	// For local endpoints the transport defaults to a non-empty bearer token
	// (`local-classifier.ts` falls back to the provider id), so an apiKey in
	// the config is optional. For catalog providers the user must either
	// supply a secret or accept "no api key" - the wizard does not write a
	// literal token to disk in either path.

	const suggestedName = defaultDecisionModelName(option.provider, id);
	const name = await promptNameLast(
		ctx,
		session.loaded,
		suggestedName,
		knownNames,
	);
	if (name === undefined) return undefined;

	// Commit the apiKey value (if any) under the now-known name, then build the
// DecisionModelInput. Deferring the write keeps the secret name aligned with
// the decision-model name regardless of whether the user kept the suggested
// default or typed their own.
	let finalRest: Partial<DecisionModelInput> = rest;
	if (apiKeyResult.kind === "secret") {
		const secretName = secretNameFor(name);
		try {
			session.secrets.set(secretName, apiKeyResult.value);
		} catch (error) {
			ctx.ui.notify(`secret store refused the value: ${errorMessage(error)}`, "error");
			return undefined;
		}
		finalRest = { ...rest, apiKeySecretName: secretName };
	}

	const input: DecisionModelInput = { name, provider: option.provider, id, ...finalRest };
	try {
		addDecisionModel(session.loaded, input);
	} catch (error) {
		ctx.ui.notify(errorMessage(error), "warning");
		return undefined;
	}
	if (await saveOrRevert(ctx, session)) {
		ctx.ui.notify(`decision model "${name}" added`, "info");
		await offerClassifierTest(ctx, session, jevFromInput({ provider: option.provider, id, rest: finalRest }));
		return input;
	}
	return undefined;
}

/** The inline classifier config a wizard result describes (used for the capability test). */
function jevFromInput(fields: { provider: string; id: string; rest?: Partial<DecisionModelInput> }): JevConfig {
	const rest = fields.rest ?? {};
	return {
		provider: fields.provider,
		id: fields.id,
		...(rest.baseUrl !== undefined ? { baseUrl: rest.baseUrl } : {}),
		...(rest.api !== undefined ? { api: rest.api } : {}),
		...(rest.apiKeySecretName !== undefined ? { apiKey: `secret:${rest.apiKeySecretName}` } : {}),
	};
}

/**
 * Choose the classifier provider.
 *
 * The picker shows two sections, separated by header lines that explain what
 * each side means:
 *
 *   - Catalog providers (resolved through pi) - TypeSafe, OpenRouter, ...
 *     These speak `typesafe-system-one` over HTTPS; the wizard sets the
 *     provider's default baseUrl automatically.
 *   - Local SystemOne endpoints (you run the server) - Ollama, llama.cpp.
 *     The wizard sets the `/v1/systemone` baseUrl from OLLAMA_HOST /
 *     LLAMA_SERVER_URL or a well-known default; switchback registers the
 *     classifier itself.
 *
 * "Other (type a provider id)..." is the escape hatch for a custom provider
 * not in either section. The provider already in use, if any, is offered first
 * so Enter keeps it.
 *
 * Falls back to a text prompt when no catalog was supplied (non-TUI contexts,
 * tests).
 */
async function chooseClassifierProvider(
	ctx: DialogueContext,
	session: DialogueSession,
	current: string | undefined,
): Promise<ClassifierProviderOption | undefined> {
	const options = ctx.classifierProviders ?? [];
	if (options.length === 0) {
		const provider = await promptRequired(
			ctx,
			screenTitle(session.loaded, "classifier provider"),
			current ?? "",
		);
		if (provider === undefined) return undefined;
		return declaredEndpoint(provider);
	}
	// The provider already in use is offered first so Enter keeps it.
	const ordered = [...options].sort((a, b) => (a.provider === current ? -1 : b.provider === current ? 1 : 0));
	const otherOption = "Other (type a provider id)...";
	const backOption = "Back";
	const choice = await ctx.ui.select(
		screenTitle(
			session.loaded,
			`classifier provider${current === undefined ? "" : ` (current: ${current})`}`,
		),
		[...ordered.map((option) => option.label), otherOption, backOption],
	);
	if (choice === undefined || choice === backOption) return undefined;
	if (choice === otherOption) {
		const provider = await promptRequired(ctx, screenTitle(session.loaded, "classifier provider id"), current ?? "");
		if (provider === undefined) return undefined;
		return declaredEndpoint(provider);
	}
	const index = ordered.findIndex((o) => o.label === choice);
	return index >= 0 ? ordered[index] : undefined;
}

/**
 * An endpoint the user names themselves: pi has no catalog entry for it, so
 * switchback registers the classifier from the config (`baseUrl` present). No
 * base URL or wire API is invented here - the wizard asks for both.
 */
function declaredEndpoint(provider: string): ClassifierProviderOption {
	return { provider, label: provider, displayName: provider, models: [], local: true, chatModels: 0 };
}

/** Choose the classifier model id from the provider's known classifiers, or type one.
 *
 * The picker offers what pi's catalog knows for this provider. When the catalog
 * knows nothing and the endpoint is reachable, the wizard asks the server
 * itself (Ollama's `/api/tags`, filtered by the `decision` capability) so a
 * freshly pointed endpoint does not have to wait for a routing failure to reveal
 * a wrong model id. Provider-agnostic on purpose: the trigger is "the catalog
 * cannot help here", not a hardcoded provider name.
 */
async function chooseClassifierModel(
	ctx: DialogueContext,
	session: DialogueSession,
	option: ClassifierProviderOption,
	current: string | undefined,
	baseUrl: string | undefined,
): Promise<string | undefined> {
	const prompt = (): Promise<string | undefined> =>
		promptRequired(
			ctx,
			screenTitle(session.loaded, `classifier model id for ${option.provider}`),
			current ?? "",
		);

	let liveModels: readonly string[] = option.models;
	if (liveModels.length === 0 && baseUrl !== undefined) {
		const { models, error } = await discoverOllamaModels({ baseUrl });
		if (error !== undefined) {
			ctx.ui.notify(`no model list from ${baseUrl} (${error}); type the model id`, "warning");
		}
		const decisionOnly = models.filter((m) => m.decisionCapable).map((m) => m.id);
		if (decisionOnly.length > 0) liveModels = decisionOnly;
	}

	if (liveModels.length === 0) return prompt();
	const otherOption = "Other (type a model id)...";
	const backOption = "Back";
	const choice = await ctx.ui.select(
		screenTitle(session.loaded, `classifier model for ${option.provider}`),
		[...liveModels, otherOption, backOption],
	);
	if (choice === undefined || choice === backOption) return undefined;
	if (choice === otherOption) return prompt();
	return choice;
}

/**
 * The base URL for the chosen endpoint.
 *
 * Two shapes, because the config means different things by the field:
 *
 *  - An endpoint the user declared (pi has no catalog entry): the base URL is
 *    required, since switchback registers the classifier from it.
 *  - A provider from pi's catalog: pi already resolves the endpoint, so the
 *    config normally carries **no** `baseUrl` at all and `Enter` keeps that.
 *    Typing one is an explicit override - and when pi owns chat models under
 *    that provider id, writing a direct endpoint would make pi replace them
 *    (its `applyExtension`), so the wizard refuses and says so.
 *
 * `"-"` always means "no direct endpoint".
 */
async function chooseBaseUrl(
	ctx: DialogueContext,
	session: DialogueSession,
	option: ClassifierProviderOption,
	current: string | undefined,
): Promise<string | null | undefined> {
	if (option.local) {
		const value = await promptOptional(
			ctx,
			screenTitle(
				session.loaded,
				`baseUrl for ${option.provider} — the SystemOne endpoint, e.g. http://host:port/v1 (required)`,
			),
			current,
		);
		if (value === undefined || value === null) return undefined;
		const trimmed = value.trim();
		// Required: an empty answer for a declared endpoint leaves nothing to register.
		return trimmed.length === 0 ? undefined : trimmed;
	}
	const note = classifierBaseUrlNote(option);
	const value = await ctx.ui.input(
		screenTitle(
			session.loaded,
			`baseUrl for ${option.provider} — Enter keeps pi's catalog (${note}), "-" clears, any URL overrides`,
		),
		current ?? "",
	);
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed === "-" || trimmed.length === 0) return null;
	if (directEndpointWouldClobber(option)) {
		ctx.ui.notify(
			`pi already serves ${option.chatModels} chat model(s) under "${option.provider}". ` +
				"A direct endpoint here would replace them with the classifier alone - " +
				`pick a distinct provider id ("${option.provider}-<suffix>") instead.`,
			"warning",
		);
		return undefined;
	}
	return trimmed;
}

/**
 * Send the capability prompt and report the verdict. See `src/classifier-probe.ts`.
 */
async function runClassifierTest(ctx: DialogueContext, session: DialogueSession, jev: JevConfig): Promise<void> {
	if (ctx.probeClassifier === undefined) return;
	const label = `${jev.provider}/${jev.id}${jev.baseUrl !== undefined ? ` at ${jev.baseUrl}` : ""}`;
	const result = await ctx.probeClassifier(resolveSecretRef(jev, session));
	ctx.ui.notify(formatProbeReport({ label, result }), result.ok ? "info" : "warning");
}

/**
 * Offer the one-shot capability test after a classifier config was written.
 *
 * Most SystemOne endpoints publish no model list, so the model id is guessed;
 * this is where a wrong guess (or a model without the `decision` capability)
 * surfaces, instead of at the first real routing failure.
 */
async function offerClassifierTest(ctx: DialogueContext, session: DialogueSession, jev: JevConfig): Promise<void> {
	if (ctx.probeClassifier === undefined) return;
	const confirmed = await ctx.ui.confirm(
		screenTitle(session.loaded, `test ${jev.provider}/${jev.id} now?`),
		"Sends one SystemOne prompt that exercises choice, score and noul, so a wrong model id or endpoint shows up immediately.",
	);
	if (!confirmed) return;
	await runClassifierTest(ctx, session, jev);
}

/** Classifier fields for a NEW inline config / decision model. Undefined = user backed out. */
async function collectJevFields(
	ctx: DialogueContext,
	session: DialogueSession,
	existing: JevConfig | undefined,
	hint?: string,
): Promise<{ provider: string; id: string; rest?: Partial<DecisionModelInput> } | undefined> {
	const option = await chooseClassifierProvider(ctx, session, existing?.provider);
	if (option === undefined) return undefined;
	const baseUrl = await chooseBaseUrl(ctx, session, option, existing?.baseUrl);
	if (baseUrl === undefined) return undefined;
	const id = await chooseClassifierModel(ctx, session, option, existing?.id, baseUrl ?? option.baseUrl);
	if (id === undefined) return undefined;
	if (baseUrl === null) return { provider: option.provider, id };
	// `api` is aligned with the endpoint instead of asked: a direct endpoint speaks
	// exactly one wire API (switchback's own SystemOne transport), so the old
	// "(none)" choice offered an option that does not exist.
	const api = option.api ?? LOCAL_CLASSIFIER_APIS[0];
	const rest: Partial<DecisionModelInput> = { baseUrl, ...(api !== undefined ? { api } : {}) };
	const key = await apiKeyAction(ctx, session, existing?.apiKey, hint ?? option.provider);
	if (key.kind === "cancel") return undefined;
	if (key.kind === "secret") {
		const committedName = commitSecret(ctx, session, hint ?? option.provider, key.value);
		if (committedName === undefined) return undefined;
		rest.apiKeySecretName = committedName;
	}
	return { provider: option.provider, id, rest };
}

/**
 * Commit a secret value to the store under a name derived from `hint`. Returns
 * the chosen name on success, undefined on failure (the wizard treats undefined
 * as user cancellation). The hint should be the decision-model name when one
 * exists, or the provider id for inline jev.
 */
function commitSecret(
	ctx: DialogueContext,
	session: DialogueSession,
	hint: string,
	value: string,
): string | undefined {
	const name = secretNameFor(hint);
	try {
		session.secrets.set(name, value);
		return name;
	} catch (error) {
		ctx.ui.notify(`secret store refused the value: ${errorMessage(error)}`, "error");
		return undefined;
	}
}

/** Patch fields for an EXISTING decision model. Undefined = user backed out. */
async function collectJevPatch(
	ctx: DialogueContext,
	session: DialogueSession,
	current: DecisionModelEntry,
): Promise<DecisionModelPatch | undefined> {
	const option = await chooseClassifierProvider(ctx, session, current.provider);
	if (option === undefined) return undefined;
	const patch: DecisionModelPatch = {};
	if (option.provider !== current.provider) patch.provider = option.provider;
	const baseUrl = await chooseBaseUrl(ctx, session, option, current.baseUrl);
	if (baseUrl === undefined) return undefined;
	const id = await chooseClassifierModel(ctx, session, option, current.id, baseUrl ?? option.baseUrl);
	if (id === undefined) return undefined;
	if (id !== current.id) patch.id = id;
	if (baseUrl === null) {
		// updateDecisionModel clears api/apiKey with baseUrl (loader rule: they require it).
		patch.baseUrl = null;
		return patch;
	}
	patch.baseUrl = baseUrl;
	// Keep the entry's own api, or set the endpoint's for a newly added one.
	if (current.api === undefined) {
		const api = option.api ?? LOCAL_CLASSIFIER_APIS[0];
		if (api !== undefined) patch.api = api;
	}
	const key = await apiKeyAction(ctx, session, current.apiKey, current.name);
	if (key.kind === "cancel") return undefined;
	if (key.kind === "none") patch.apiKeySecretName = null;
	else if (key.kind === "secret") {
		const committedName = commitSecret(ctx, session, current.name, key.value);
		if (committedName === undefined) return undefined;
		patch.apiKeySecretName = committedName;
	}
	return patch;
}

/**
 * Secret names are an internal detail of the encrypted store, so the dialogue
 * derives one instead of asking: `ollama-key`, `local-jev-key`, and so on. A
 * second key for the same entry simply replaces the stored value under that name.
 */
export function secretNameFor(hint: string): string {
	const cleaned = hint
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, "-")
		.replace(/^-+|-+$/gu, "");
	return `${cleaned.length === 0 ? "classifier" : cleaned}-key`;
}

/** Resolve a `secret:<name>` reference for use (the probe needs the real token). */
function resolveSecretRef(jev: JevConfig, session: DialogueSession): JevConfig {
	const apiKey = jev.apiKey;
	if (apiKey === undefined || !apiKey.startsWith("secret:")) return jev;
	const stored = session.secrets.get(apiKey.slice("secret:".length));
	return stored === undefined ? jev : { ...jev, apiKey: stored };
}

/**
 * What the user decided about the API key.
 *
 * `keep` leaves the field untouched (an existing key stays), `none` means "no
 * key" (a new entry gets none, an existing one loses it), `secret` names the
 * store entry to reference, and `cancel` abandons the whole step. Collapsing
 * these into one nullable string made "no key" indistinguishable from "back
 * out", which turned a valid choice into an aborted wizard.
 */
type ApiKeyAction =
	| { kind: "keep" }
	| { kind: "none" }
	/** Value picked up; the wizard commits it under a name it derives later. */
	| { kind: "secret"; value: string }
	| { kind: "cancel" };

/**
 * Ask what to do about the API key.
 *
 * The value is the only thing asked for: the store name is derived
 * (`secretNameFor`) because it is an internal detail the user has no reason to
 * invent.
 */
async function apiKeyAction(
	ctx: DialogueContext,
	session: DialogueSession,
	current: string | undefined,
	hint: string,
): Promise<ApiKeyAction> {
	const hasCurrent = current !== undefined;
	const keepOption = hasCurrent
		? `Keep current (${current.startsWith("secret:") ? current : "value set by hand"})`
		: "(no API key)";
	const existingOption = "Use existing secret...";
	const newOption = "New secret...";
	const removeOption = "Remove API key";
	const choice = await ctx.ui.select(
		screenTitle(session.loaded, "API key - stored encrypted; the config only carries secret:<name>"),
		hasCurrent ? [keepOption, existingOption, newOption, removeOption] : [keepOption, existingOption, newOption],
	);
	if (choice === undefined) return { kind: "cancel" };
	if (choice === keepOption) return hasCurrent ? { kind: "keep" } : { kind: "none" };
	if (choice === removeOption) return { kind: "none" };
	if (choice === existingOption) {
		const names = session.secrets.list();
		if (names.length === 0) {
			ctx.ui.notify("no secrets stored yet - pick 'New secret...'", "warning");
			return { kind: "cancel" };
		}
		const name = await ctx.ui.select(screenTitle(session.loaded, "reference which stored secret?"), [...names]);
		return name === undefined ? { kind: "cancel" } : { kind: "secret", value: name };
	}
	if (choice !== newOption) return { kind: "cancel" }; // an option this flow does not know: back out
	const value = await promptRequired(
		ctx,
		screenTitle(session.loaded, `API key for ${hint} - the store name is derived from the decision model, not shown again`),
		"secret value",
	);
	if (value === undefined) return { kind: "cancel" };
	return { kind: "secret", value };
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
			const fallback = await chooseFallback(
				ctx,
				session,
				screenTitle(session.loaded, `fallback ${fallbacks.length + 1} ("provider/id")`),
				fallbacks,
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
