/**
 * Interactive `/switchback-config` dialogue: an edit loop over one
 * switchback.yaml layer, built on pi's built-in dialogs (`ctx.ui.select`,
 * `confirm`, `input`, `notify`).
 *
 * This module is the shell: it picks the layer, owns the main menu, the
 * per-model menu and the fallback editor, and hands the classifier work to
 * `src/dialogue-classifier.ts`. Session state, the screen primitives and
 * every prompt live in `src/dialogue-ui.ts`.
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
	addFallback,
	addVirtualModel,
	defaultLayer,
	globalConfigPath,
	layerExists,
	loadLayer,
	moveFallback,
	projectConfigPath,
	readLayerConfig,
	removeFallback,
	removeVirtualModel,
	renameVirtualModel,
	setDebug,
	setVirtualModelName,
	type ConfigLayer,
	type LoadedLayer,
} from "./config-editor.ts";
import { createSecretStore, type SecretStore } from "./secrets.ts";
import {
	describeJev,
	errorMessage,
	findModel,
	promptRequired,
	readConfigOrReport,
	saveOrRevert,
	screenTitle,
	type DialogueContext,
	type DialogueSession,
} from "./dialogue-ui.ts";
import { decisionModelPicker, decisionModelsMenu } from "./dialogue-classifier.ts";
import type { SwitchbackConfig, SwitchbackFileConfig } from "./types.ts";

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
	const choice = await ctx.ui.select(
		title,
		order.map((layer) => labels[layer]),
	);
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

type MainOutcome = "done" | "switch";

async function mainMenu(ctx: DialogueContext, session: DialogueSession): Promise<MainOutcome> {
	for (;;) {
		// A layer with no content yet (first save) has no valid config to read;
		// offer the reduced menu until the first virtual model exists.
		if (session.loaded.doc.contents === undefined || session.loaded.doc.contents === null) {
			const choice = await ctx.ui.select(screenTitle(session.loaded, "no config in this layer yet"), [
				"Add virtual model...",
				"Switch layer...",
				"Done",
			]);
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

async function toggleDebug(
	ctx: DialogueContext,
	session: DialogueSession,
	config: SwitchbackFileConfig,
): Promise<void> {
	const next = !(config.debug === true);
	setDebug(session.loaded, next);
	if (await saveOrRevert(ctx, session)) {
		ctx.ui.notify(`debug ${next ? "on" : "off"} - saved to ${session.loaded.path}`, "info");
	}
}

async function virtualModelMenu(
	ctx: DialogueContext,
	session: DialogueSession,
	model: SwitchbackConfig,
): Promise<void> {
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
		const choice = await ctx.ui.select(screenTitle(session.loaded, `${current.id} - ${current.name}`), [
			renameIdOption,
			renameNameOption,
			fallbacksOption,
			decisionLabel,
			removeOption,
			backOption,
		]);
		if (choice === undefined || choice === backOption) return;
		if (choice === renameIdOption) {
			const newId = await promptRequired(
				ctx,
				screenTitle(
					session.loaded,
					`rename ${current.id} - new model id (bare "auto" becomes "switchback/auto")`,
				),
				current.id,
			);
			if (newId === undefined) continue;
			renameVirtualModel(session.loaded, current.id, newId);
			if (await saveOrRevert(ctx, session)) {
				model.id = newId;
				ctx.ui.notify(`renamed to ${newId} - the running pi keeps the old id until restart`, "info");
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
		const body = ["Fallbacks (first = preferred):", ...model.fallbacks.map((f, i) => `  ${i + 1}. ${f}`)].join(
			"\n",
		);
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
		ctx.ui.notify(
			`${id} added with ${fallbacks.length} fallback(s) - use its menu to attach a decision model`,
			"info",
		);
	}
}
