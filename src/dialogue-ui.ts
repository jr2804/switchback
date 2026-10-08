/**
 * The primitives layer of the `/switchback-config` dialogue.
 *
 * Everything here is shared by both halves of the dialogue - the shell
 * (`src/dialogue.ts`) and the decision-model wizard
 * (`src/dialogue-classifier.ts`) - and none of it belongs to either:
 *
 *  - the session (the loaded layer plus the secret store) and the structural
 *    UI types,
 *  - the primitives every screen needs: a screen title naming the file being
 *    edited, a validated read of that layer, a save that either succeeds or
 *    reverts exactly the failed action, and a model lookup,
 *  - every prompt (required, name-last, optional) in one place, so the wording
 *    of "a value is required" or "empty clears, Esc keeps" is defined once,
 *  - the two pure formatters that render a classifier for a menu
 *    (`describeJev`) or name its secret entry (`secretNameFor`).
 *
 * It is a module of its own so the two halves can both depend on it without
 * importing each other.
 *
 * See `src/dialogue.ts` for the design of the dialogue as a whole.
 */

import { loadLayer, readLayerConfig, saveLayer, type LoadedLayer } from "./config-editor.ts";
import type { ClassifierProviderOption } from "./classifier-catalog.ts";
import type { ProbeResult } from "./classifier-probe.ts";
import type { SecretStore } from "./secrets.ts";
import type { JevConfig, JevRef, SwitchbackConfig, SwitchbackFileConfig } from "./types.ts";

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

export interface DialogueSession {
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
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function screenTitle(loaded: LoadedLayer, body: string): string {
	const fresh = loaded.existed ? "" : " (new file)";
	return `[${loaded.layer} layer: ${loaded.path}${fresh}]\n${body}`;
}
/**
 * The validated config snapshot for menus; a file that fails the loader's
 * rules is reported (with the fix hint) and ends the dialogue - the editor
 * only round-trips config the loader itself accepts.
 */
export function readConfigOrReport(ctx: DialogueContext, loaded: LoadedLayer): SwitchbackFileConfig | undefined {
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
export async function saveOrRevert(ctx: DialogueContext, session: DialogueSession): Promise<boolean> {
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
export function tryReadConfig(loaded: LoadedLayer): SwitchbackFileConfig | undefined {
	try {
		return readLayerConfig(loaded);
	} catch {
		return undefined;
	}
}
/** Required single-line input: Esc aborts the step, empty input re-prompts. */
export async function promptRequired(
	ctx: DialogueContext,
	title: string,
	placeholder: string,
): Promise<string | undefined> {
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
export async function promptNameLast(
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
export async function promptOptional(
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
export function findModel(config: SwitchbackFileConfig, id: string): SwitchbackConfig | undefined {
	return config.models.find((m) => m.id === id);
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
