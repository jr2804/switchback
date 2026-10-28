/**
 * The guided config editor for the TUI: layer 2a.
 *
 * Layer 1 gave `/switchback-config` a complete argument grammar, and that
 * grammar is the *only* writer of `switchback.yaml` in this package. Typing
 * `chain-move auto 2 1` is fine when you know the chain, but pi's dialogue is a
 * menu - pick the chain, pick the fallback, pick the model from a searchable
 * catalog - and that is what this module reproduces.
 *
 * It is deliberately not a second editor. Every action it offers is expressed
 * as the layer-1 verb that would do the same thing, and dispatched through the
 * same `execute()` call the command uses, so the two surfaces cannot drift:
 *
 *     pick "raise fallback"  ->  `chain-move <id> <n> <n-1>`
 *     pick a catalog model   ->  `chain-add <id> <provider/model>`
 *
 * The module owns presentation and navigation only. It takes a `GuidePorts`
 * bundle - a dialog to ask with, the chains currently on disk, the catalog to
 * offer, a dispatcher, and a reload hook - so the whole flow is testable with a
 * scripted dialog and no TUI, no host, and no files.
 *
 * Cancelling is never an error: Esc at any screen returns to the previous one,
 * and Esc from the top menu closes the guide having changed nothing. A rejected
 * edit (the loader refusing an address, say) is reported as a toast and the
 * guide re-reads the chains, because a failed save leaves the file untouched.
 */

import { IDLE_RESET_OPTIONS } from "switchback-core";
import { fuzzyFilter } from "./fuzzy.ts";

/** A chain as the guide shows it: identity plus the ordered fallbacks. */
export interface GuideChain {
	readonly id: string;
	readonly name: string;
	readonly fallbacks: readonly string[];
	readonly idleReset?: string;
	readonly decisionModel?: string;
}

/** One catalog entry the model picker can offer. */
export interface GuideModel {
	/** `provider/model`. */
	readonly address: string;
	/** Display name, used as the picker description. */
	readonly name: string;
	/** Context window in tokens, when the catalog knows it. */
	readonly contextWindow?: number;
	/** False when the provider is not authenticated (shown, never enforced). */
	readonly ready: boolean;
}

/** The dialog surface the guide needs; OpenCode's `ui.dialog` satisfies it. */
export interface GuideDialog {
	select<Value>(options: {
		readonly title: string;
		readonly placeholder?: string;
		readonly options: readonly GuideOption<Value>[];
		readonly current?: Value;
		readonly search?: (query: string, options: readonly GuideOption<Value>[]) => readonly GuideOption<Value>[];
	}): Promise<Value | undefined>;
	prompt(options: {
		readonly title: string;
		readonly description?: string;
		readonly placeholder?: string;
		readonly value?: string;
	}): Promise<string | undefined>;
	confirm(options: { readonly title: string; readonly message: string }): Promise<boolean | undefined>;
}

/** One dialog option (structurally the host's `DialogSelectOption`). */
export interface GuideOption<Value> {
	readonly title: string;
	readonly value: Value;
	readonly description?: string;
}

/** The result of one dispatched layer-1 verb. */
export interface GuideEdit {
	readonly ok: boolean;
	readonly text: string;
}

/** Everything the guide needs from its host. */
export interface GuidePorts {
	readonly dialog: GuideDialog;
	/** The chains on disk right now (re-read on every menu). */
	readonly chains: () => readonly GuideChain[];
	/** The models the catalog offers, in catalog order. */
	readonly models: () => readonly GuideModel[];
	/** Run one layer-1 verb, e.g. `chain-add auto zai/glm-5.3-flash`. */
	readonly run: (verbText: string) => Promise<GuideEdit>;
	/** Ask the server to republish providers after a successful edit. */
	readonly reload: () => Promise<void>;
	/** Report to the user (toast). */
	readonly say: (message: string, variant: "info" | "success" | "warning" | "error") => void;
}

/** Compact context label for the picker description ("200k", "1M"). */
export function contextLabel(contextWindow: number | undefined): string | undefined {
	if (contextWindow === undefined || contextWindow <= 0) return undefined;
	if (contextWindow >= 1_000_000) {
		const millions = contextWindow / 1_000_000;
		return `${(millions >= 10 ? millions.toFixed(0) : millions.toFixed(1)).replace(/\.0$/u, "")}M`;
	}
	if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}k`;
	return String(contextWindow);
}

/**
 * Picker options for the catalog: `provider/model`, described by display name,
 * context window and whether credentials exist. Ordering follows the catalog;
 * the dialog's search reorders from there.
 */
export function modelOptions(models: readonly GuideModel[], current: readonly string[] = []): GuideOption<string>[] {
	const existing = new Set(current);
	return models.map((model) => ({
		title: model.address,
		value: model.address,
		description: [
			model.name,
			contextLabel(model.contextWindow) === undefined
				? undefined
				: `${contextLabel(model.contextWindow)} context`,
			model.ready ? undefined : "no credentials",
			existing.has(model.address) ? "in the chain" : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join(" · "),
	}));
}

/**
 * Search over picker options, matching title *and* description so a model whose
 * display name matches is found too. Uses the same subsequence scorer as the
 * rest of the plugin (`./fuzzy.ts`), so `/switchback-model` and this picker
 * behave alike.
 */
export function searchModelOptions(
	query: string,
	options: readonly GuideOption<string>[],
): readonly GuideOption<string>[] {
	return fuzzyFilter(
		options.map((option) => ({ value: option, text: option.title })),
		query,
		(item) => (item.value.description === undefined ? [] : [item.value.description]),
	).map((item) => item.value);
}

/** A chain title for the top menu: `id - name (3 fallbacks)`. */
function chainTitle(chain: GuideChain): string {
	const count = chain.fallbacks.length;
	return `${chain.id} - ${chain.name} (${count} fallback${count === 1 ? "" : "s"})`;
}

/** The chain's option summary, shown under its title. */
function chainDescription(chain: GuideChain): string {
	const parts = [chain.fallbacks.length === 0 ? "empty chain" : chain.fallbacks[0]!];
	if (chain.fallbacks.length > 1) parts.push(`+${chain.fallbacks.length - 1} more`);
	if (chain.decisionModel !== undefined) parts.push(`decision ${chain.decisionModel}`);
	if (chain.idleReset !== undefined) parts.push(`idle-reset ${chain.idleReset}`);
	return parts.join(" · ");
}

/**
 * Ask the user to pick one catalog model. Returns undefined when cancelled.
 * `exclude` hides addresses already used elsewhere in the chain, which is what
 * makes `chain-add` (which appends) safe to offer repeatedly.
 */
async function pickModel(ports: GuidePorts, title: string, exclude: readonly string[]): Promise<string | undefined> {
	const options = modelOptions(ports.models(), exclude);
	if (options.length === 0) {
		ports.say("switchback: the catalog has no models to choose from", "warning");
		return undefined;
	}
	return ports.dialog.select({
		title,
		placeholder: "type to search models (provider/model)",
		options,
		search: searchModelOptions,
	});
}

/** Dispatch one verb and report the outcome. Returns whether it landed. */
async function dispatch(ports: GuidePorts, verbText: string): Promise<boolean> {
	const result = await ports.run(verbText);
	if (!result.ok) {
		ports.say(result.text, "error");
		return false;
	}
	ports.say(result.text.split("\n")[0] ?? "switchback: configuration updated", "success");
	await ports.reload().catch(() => {
		// Republishing is best effort: the edit is already on disk, and the next
		// request reads the file regardless.
	});
	return true;
}

/** The idle-reset menu, in the order the config documents. */
async function editIdleReset(ports: GuidePorts, chain: GuideChain): Promise<void> {
	const value = await ports.dialog.select<string | null>({
		title: `idle-reset for ${chain.id}`,
		options: [
			...IDLE_RESET_OPTIONS.map((option) => ({
				title: option,
				value: option as string,
				description:
					option === "never"
						? "stay on the current model however long the session idles"
						: option === "classifier"
							? "ask the decision model whether returning is worthwhile"
							: `return to the head of the chain after ${option} idle`,
			})),
		],
		current: chain.idleReset ?? "never",
	});
	if (value === undefined) return;
	await dispatch(ports, `idle-reset ${chain.id} ${value}`);
}

/** The decision-model menu: pick a classifier from the catalog, or turn it off. */
async function editDecisionModel(ports: GuidePorts, chain: GuideChain): Promise<void> {
	const current = chain.decisionModel;
	const address = await ports.dialog.select<string | null>({
		title: `decision model for ${chain.id}`,
		placeholder: "type to search models, or pick 'off'",
		options: [
			{ title: "off", value: null, description: "cycle blindly when no classifier is configured" },
			...modelOptions(ports.models()),
		],
		current: current ?? null,
		search: (query, options) => {
			if (query.trim().length === 0) return options;
			// Keep the "off" escape hatch reachable whatever the query is.
			const off = options.filter((option) => option.value === null);
			const rest = options.filter((option) => option.value !== null) as readonly GuideOption<string>[];
			return [...off, ...searchModelOptions(query, rest)];
		},
	});
	if (address === undefined) return;
	await dispatch(ports, `decision-model ${chain.id} ${address ?? "off"}`);
}

/** Append one catalog model to a chain. */
async function addFallback(ports: GuidePorts, chain: GuideChain): Promise<void> {
	const address = await pickModel(ports, `add a fallback to ${chain.id}`, chain.fallbacks);
	if (address === undefined) return;
	await dispatch(ports, `chain-add ${chain.id} ${address}`);
}

/** Remove one fallback (by position), refusing to leave the chain empty. */
async function removeFallback(ports: GuidePorts, chain: GuideChain): Promise<void> {
	if (chain.fallbacks.length === 0) {
		ports.say(`switchback: ${chain.id} has no fallbacks to remove`, "warning");
		return;
	}
	const position = await ports.dialog.select({
		title: `remove which fallback from ${chain.id}?`,
		options: chain.fallbacks.map((address, index) => ({
			title: `${index + 1}. ${address}`,
			value: index + 1,
		})),
	});
	if (position === undefined) return;
	await dispatch(ports, `chain-remove ${chain.id} ${position}`);
}

/** Raise a fallback one position (the first one cannot move). */
async function raiseFallback(ports: GuidePorts, chain: GuideChain): Promise<void> {
	if (chain.fallbacks.length < 2) {
		ports.say(`switchback: ${chain.id} needs at least two fallbacks to reorder`, "warning");
		return;
	}
	const position = await ports.dialog.select({
		title: `raise which fallback in ${chain.id}?`,
		options: chain.fallbacks.slice(1).map((address, index) => ({
			title: `${index + 2}. ${address} -> ${index + 1}`,
			value: index + 2,
		})),
	});
	if (position === undefined) return;
	await dispatch(ports, `chain-move ${chain.id} ${position} ${position - 1}`);
}

/** Lower a fallback one position (the last one cannot move). */
async function lowerFallback(ports: GuidePorts, chain: GuideChain): Promise<void> {
	if (chain.fallbacks.length < 2) {
		ports.say(`switchback: ${chain.id} needs at least two fallbacks to reorder`, "warning");
		return;
	}
	const position = await ports.dialog.select({
		title: `lower which fallback in ${chain.id}?`,
		options: chain.fallbacks.slice(0, -1).map((address, index) => ({
			title: `${index + 1}. ${address} -> ${index + 2}`,
			value: index + 1,
		})),
	});
	if (position === undefined) return;
	await dispatch(ports, `chain-move ${chain.id} ${position} ${position + 1}`);
}

/** Rename a chain's display name, which the grammar accepts with spaces. */
async function renameChain(ports: GuidePorts, chain: GuideChain): Promise<void> {
	const name = await ports.dialog.prompt({
		title: `display name for ${chain.id}`,
		placeholder: chain.name,
		value: chain.name,
	});
	if (name === undefined) return;
	const trimmed = name.trim();
	if (trimmed.length === 0) {
		ports.say("switchback: a display name cannot be empty", "warning");
		return;
	}
	await dispatch(ports, `name ${chain.id} ${trimmed}`);
}

/** Change a chain's id (the selector entry the user picks). */
async function renameChainId(ports: GuidePorts, chain: GuideChain): Promise<void> {
	const id = await ports.dialog.prompt({
		title: `id for ${chain.id}`,
		description: "the selector shows this as switchback/<id>; takes effect after the models republish",
		placeholder: chain.id,
		value: chain.id,
	});
	if (id === undefined) return;
	const trimmed = id.trim();
	if (trimmed.length === 0 || trimmed === chain.id) return;
	await dispatch(ports, `rename ${chain.id} ${trimmed}`);
}

/** Delete a chain, refusing the last one (the loader requires at least one). */
async function removeChain(ports: GuidePorts, chain: GuideChain): Promise<void> {
	const confirmed = await ports.dialog.confirm({
		title: `remove ${chain.id}?`,
		message: `${chain.name} and its ${chain.fallbacks.length} fallback(s) will be removed from switchback.yaml.`,
	});
	if (confirmed !== true) return;
	await dispatch(ports, `remove ${chain.id}`);
}

/** The per-chain menu. Returns when the user goes back or cancels. */
export async function editChain(ports: GuidePorts, chainId: string): Promise<void> {
	for (;;) {
		const chain = ports.chains().find((entry) => entry.id === chainId);
		if (chain === undefined) {
			ports.say(`switchback: ${chainId} is no longer configured`, "warning");
			return;
		}
		const action = await ports.dialog.select<
			"add" | "remove" | "raise" | "lower" | "idle" | "decision" | "name" | "id" | "delete" | "back"
		>({
			title: chainTitle(chain),
			options: [
				{ title: "Add a fallback", value: "add", description: "pick a model from the catalog" },
				{
					title: "Remove a fallback",
					value: "remove",
					...(chain.fallbacks.length === 0 ? { description: "the chain is empty" } : {}),
				},
				{
					title: "Raise a fallback",
					value: "raise",
					...(chain.fallbacks.length < 2 ? { description: "needs at least two fallbacks" } : {}),
				},
				{
					title: "Lower a fallback",
					value: "lower",
					...(chain.fallbacks.length < 2 ? { description: "needs at least two fallbacks" } : {}),
				},
				{
					title: "Idle reset",
					value: "idle",
					description: `now: ${chain.idleReset ?? "never"}`,
				},
				{
					title: "Decision model",
					value: "decision",
					description: `now: ${chain.decisionModel ?? "none (blind cycle)"}`,
				},
				{ title: "Rename display name", value: "name", description: chain.name },
				{ title: "Change id", value: "id", description: chain.id },
				{ title: "Remove this chain", value: "delete" },
				{ title: "Back", value: "back" },
			],
		});
		if (action === undefined || action === "back") return;
		switch (action) {
			case "add":
				await addFallback(ports, chain);
				break;
			case "remove":
				await removeFallback(ports, chain);
				break;
			case "raise":
				await raiseFallback(ports, chain);
				break;
			case "lower":
				await lowerFallback(ports, chain);
				break;
			case "idle":
				await editIdleReset(ports, chain);
				break;
			case "decision":
				await editDecisionModel(ports, chain);
				break;
			case "name":
				await renameChain(ports, chain);
				break;
			case "id":
				await renameChainId(ports, chain);
				break;
			case "delete":
				await removeChain(ports, chain);
				return;
		}
	}
}

/** Create a chain: id, display name, then fallbacks picked from the catalog. */
export async function addChain(ports: GuidePorts): Promise<void> {
	const id = await ports.dialog.prompt({
		title: "new chain id",
		description: "the selector shows this as switchback/<id>",
		placeholder: "auto",
		value: "auto",
	});
	if (id === undefined) return;
	const trimmedId = id.trim();
	if (trimmedId.length === 0) {
		ports.say("switchback: a chain id cannot be empty", "warning");
		return;
	}
	// The grammar takes the display name as ONE token, so the dialogue adds the
	// chain with its id as the name and renames it afterwards when the user
	// gives something with spaces.
	const displayName = await ports.dialog.prompt({
		title: "display name",
		description: "shown in the model selector",
		placeholder: trimmedId,
		value: trimmedId,
	});
	if (displayName === undefined) return;
	const first = await pickModel(ports, "first fallback", []);
	if (first === undefined) return;
	if (!(await dispatch(ports, `add ${trimmedId} ${trimmedId} ${first}`))) return;
	const name = displayName.trim();
	if (name.length > 0 && name !== trimmedId) await dispatch(ports, `name ${trimmedId} ${name}`);

	// Offer to keep adding, so a new chain can be built in one pass.
	for (;;) {
		const chain = ports.chains().find((entry) => entry.id === trimmedId);
		if (chain === undefined) return;
		const next = await pickModel(ports, `add another fallback to ${trimmedId}`, chain.fallbacks);
		if (next === undefined) return;
		if (!(await dispatch(ports, `chain-add ${trimmedId} ${next}`))) return;
	}
}

/** The top menu: pick a chain, add one, or leave. */
export async function runGuide(ports: GuidePorts): Promise<void> {
	for (;;) {
		const chains = ports.chains();
		const choice = await ports.dialog.select<string | null>({
			title: "switchback configuration",
			placeholder: chains.length === 0 ? "no chains configured yet" : "type to filter chains",
			options: [
				...chains.map((chain) => ({
					title: chainTitle(chain),
					value: chain.id as string | null,
					description: chainDescription(chain),
				})),
				{ title: "Add a chain", value: null, description: "create a new virtual model" },
			],
		});
		if (choice === undefined) return;
		if (choice === null) {
			await addChain(ports);
			continue;
		}
		await editChain(ports, choice);
	}
}
