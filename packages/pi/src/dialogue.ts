/**
 * Interactive `/switchback-config` dialogue: an edit loop over switchback.yaml,
 * built on pi's built-in dialogs (`ctx.ui.select`, `confirm`, `input`,
 * `notify`).
 *
 * This module is the shell: it owns the main menu, the per-model menu and the
 * fallback editor, and hands the classifier work to
 * `src/dialogue-classifier.ts`. Session state, the screen primitives and every
 * prompt live in `src/dialogue-ui.ts`.
 *
 * Design: every mutation goes through `packages/core/src/config-editor.ts` and is saved
 * immediately (`saveConfigFile`). The file on disk therefore always holds the
 * last good config, which makes failure handling trivial: when a save
 * throws the loader's own ConfigError, the dialogue reports it and reloads
 * the file from disk - exactly the failed action is reverted, nothing else.
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
 * One file, no layer choice: `configFilePath()` is the config every switchback
 * host reads. Screen titles carry its path, so it is always obvious what is
 * being edited.
 */

import {
	addFallback,
	addVirtualModel,
	loadConfigFile,
	moveFallback,
	removeFallback,
	removeVirtualModel,
	renameVirtualModel,
	setDebug,
	setVirtualModelName,
	type LoadedConfig,
} from "switchback-core/config-editor.ts";
import { createSecretStore, type SecretStore } from "./secrets.ts";
import {
	describeDecisionModel,
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
import type { SwitchbackConfig, SwitchbackFileConfig } from "switchback-core/types.ts";

/**
 * Run the dialogue. Returns when the user is done; every completed action has
 * already been saved to the config file by then.
 */
export async function runDialogue(ctx: DialogueContext, store?: SecretStore): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/switchback-config needs a UI-capable context (TUI or RPC)", "warning");
		return;
	}
	const secrets = store ?? createSecretStore();
	const loaded = openConfig(ctx);
	if (loaded === undefined) return;
	const session: DialogueSession = { loaded, secrets };
	await mainMenu(ctx, session);
}

/** Load the config for editing; a read or YAML failure is reported and ends the dialogue. */
function openConfig(ctx: DialogueContext): LoadedConfig | undefined {
	try {
		return loadConfigFile();
	} catch (error) {
		ctx.ui.notify(`cannot open the switchback config: ${errorMessage(error)}`, "error");
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

async function mainMenu(ctx: DialogueContext, session: DialogueSession): Promise<void> {
	for (;;) {
		// A fresh file (first save) has no valid config to read; offer the reduced
		// menu until the first virtual model exists.
		if (session.loaded.doc.contents === undefined || session.loaded.doc.contents === null) {
			const choice = await ctx.ui.select(screenTitle(session.loaded, "no config in this file yet"), [
				"Add virtual model...",
				"Done",
			]);
			if (choice === undefined || choice === "Done") return;
			await addVirtualModelWizard(ctx, session);
			continue;
		}
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const options: string[] = config.models.map((m) => `${m.id} - ${m.name}`);
		const addOption = "Add virtual model...";
		const debugOption = `Toggle debug (currently ${config.debug === true ? "on" : "off"})`;
		const dmOption = `Decision models (${Object.keys(config.decisionModels ?? {}).length})...`;
		const doneOption = "Done";
		options.push(addOption, debugOption, dmOption, doneOption);

		const choice = await ctx.ui.select(screenTitle(session.loaded, "switchback configuration"), options);
		if (choice === undefined || choice === doneOption) return;
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
	const decisionOption = (config: SwitchbackConfig): string =>
		`Decision model: ${describeDecisionModel(config.decisionModel)}`;
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
