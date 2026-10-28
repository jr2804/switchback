/**
 * The primitives layer of the `/switchback-config` dialogue.
 *
 * Everything here is shared by both halves of the dialogue - the shell
 * (`src/dialogue.ts`) and the decision-model wizard
 * (`src/dialogue-classifier.ts`) - and none of it belongs to either:
 *
 *  - the session (the loaded config file plus the secret store) and the structural
 *    UI types,
 *  - the primitives every screen needs: a screen title naming the file being
 *    edited, a validated read of that file, a save that either succeeds or
 *    reverts exactly the failed action, and a model lookup,
 *  - every prompt (required, name-last, optional) in one place, so the wording
 *    of "a value is required" or "empty clears, Esc keeps" is defined once,
 *  - the two pure formatters that render a decision model for a menu
 *    (`describeDecisionModel`) or name its secret entry (`secretNameFor`).
 *
 * It is a module of its own so the two halves can both depend on it without
 * importing each other.
 *
 * See `src/dialogue.ts` for the design of the dialogue as a whole.
 */

import { loadConfigFile, readConfigFile, saveConfigFile, type LoadedConfig } from "switchback-core/config-editor.ts";
import type { ClassifierProviderOption } from "switchback-core/classifier-catalog.ts";
import type { ProbeResult } from "switchback-core/classifier-probe.ts";
import type { SecretStore } from "./secrets.ts";
import type {
	DecisionModelConfig,
	DecisionModelId,
	SwitchbackConfig,
	SwitchbackFileConfig,
} from "switchback-core/types.ts";

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
	 * choice and base-URL defaults (see `packages/core/src/classifier-catalog.ts`). Empty or
	 * absent falls back to free-text prompts.
	 */
	classifierProviders?: readonly ClassifierProviderOption[];
	/**
	 * Send the one-shot capability prompt (choice + score + noul) to a configured
	 * decision model. Supplied by the command handler, which has the model registry
	 * and switchback's transport; absent means the test is not offered.
	 */
	probeClassifier?: (decisionModel: DecisionModelConfig) => Promise<ProbeResult>;
}

export interface DialogueSession {
	loaded: LoadedConfig;
	secrets: SecretStore;
}
/** Describe a model's decision model for menus: its address, or none. */
export function describeDecisionModel(decisionModel: DecisionModelId | undefined): string {
	if (decisionModel === undefined) return "(none - report and cycle)";
	return `decision model ${decisionModel}`;
}
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function screenTitle(loaded: LoadedConfig, body: string): string {
	const fresh = loaded.existed ? "" : " (new file)";
	return `[${loaded.path}${fresh}]\n${body}`;
}
/**
 * The validated config snapshot for menus; a file that fails the loader's
 * rules is reported (with the fix hint) and ends the dialogue - the editor
 * only round-trips config the loader itself accepts.
 */
export function readConfigOrReport(ctx: DialogueContext, loaded: LoadedConfig): SwitchbackFileConfig | undefined {
	try {
		return readConfigFile(loaded);
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
 * reload the file from disk so exactly the failed action is reverted (the
 * file on disk always holds the last good config). Returns true when saved.
 */
export async function saveOrRevert(ctx: DialogueContext, session: DialogueSession): Promise<boolean> {
	try {
		saveConfigFile(session.loaded);
		return true;
	} catch (error) {
		ctx.ui.notify(
			`${screenTitle(session.loaded, "not saved")}\n${errorMessage(error)}\nThe change was reverted - the file on disk is unchanged.`,
			"error",
		);
		try {
			session.loaded = loadConfigFile();
		} catch (reloadError) {
			ctx.ui.notify(`cannot reload the config after a failed save: ${errorMessage(reloadError)}`, "error");
		}
		return false;
	}
}

/**
 * The validated config snapshot, or undefined when the file has no content
 * yet (fresh file) - callers treat undefined as "nothing to clash with"; the
 * save gate still validates everything that ends up in the file.
 */
export function tryReadConfig(loaded: LoadedConfig): SwitchbackFileConfig | undefined {
	try {
		return readConfigFile(loaded);
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
 * Address-last step of the decision-model wizard: the input arrives prefilled
 * with a derived `provider/model-id`, empty input keeps the default, Esc aborts.
 * An address already in use, or one without a `/`, is rejected with a warning
 * and the prompt loops.
 */
export async function promptAddressLast(
	ctx: DialogueContext,
	loaded: LoadedConfig,
	suggestedAddress: string,
	knownAddresses: readonly string[],
): Promise<string | undefined> {
	for (;;) {
		const value = await ctx.ui.input(
			screenTitle(loaded, `new decision model - address (Enter keeps "${suggestedAddress}")`),
			suggestedAddress,
		);
		if (value === undefined) return undefined;
		const trimmed = value.trim();
		const address = trimmed.length === 0 ? suggestedAddress : trimmed;
		if (!address.includes("/")) {
			ctx.ui.notify(`an address is "provider/model-id" - "${address}" has no provider`, "warning");
			continue;
		}
		if (knownAddresses.includes(address)) {
			ctx.ui.notify(`a decision model at "${address}" already exists`, "warning");
			continue;
		}
		return address;
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
 * derives one instead of asking: `ollama-key`, `local-decisionModel-key`, and so on. A
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
