/**
 * The guided config editor for the TUI.
 *
 * `/switchback-config` already had a complete argument grammar, and that
 * grammar is the *only* writer of `switchback.yaml` in this package. Typing
 * `chain-move auto 2 1` is fine when you know the chain, but pi's dialogue is a
 * menu - pick the chain, pick the fallback, pick the model from a searchable
 * catalog - and that is what this module reproduces.
 *
 * It is deliberately not a second editor. Every action it offers is expressed
 * as the typed verb that would do the same thing, and dispatched through the
 * same `execute()` call the command uses, so the two surfaces cannot drift:
 *
 *     pick "raise fallback"  ->  `chain-move <id> <n> <n-1>`
 *     pick a catalog model   ->  `chain-add <id> <provider/model>`
 *     connect a provider     ->  `provider <id> <url> [local | secret:<name>]`
 *
 * The module owns presentation and navigation only. It takes a `GuidePorts`
 * bundle - a dialog to ask with, the chains currently on disk, the catalog to
 * offer, the decision-model connections on file, a classifier probe, a
 * dispatcher, and a reload hook - so the whole flow is testable with a
 * scripted dialog and no TUI, no host, no network, and no files.
 *
 * Cancelling is never an error: Esc at any screen returns to the previous one,
 * and Esc from the top menu closes the guide having changed nothing. A rejected
 * edit (the loader refusing an address, say) is reported as a toast and the
 * guide re-reads the chains, because a failed save leaves the file untouched.
 */

import { formatProbeReport, IDLE_RESET_OPTIONS, type ProbeResult } from "switchback-core";
import { decisionModelConnection, splitDecisionModelAddress } from "switchback-core/classifier-connection.ts";
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

/** One `decisionProviders:` entry: the connection every decision model of that provider shares. */
export interface GuideProviderConnection {
	readonly provider: string;
	readonly baseUrl?: string;
	/** As written in the file: "local" or "secret:<name>" - never a resolved key. */
	readonly apiKey?: string;
}

/** One per-address `decisionModels:` entry, for a model that needs its own endpoint. */
export interface GuideConnectionOverride {
	readonly address: string;
	readonly baseUrl?: string;
	readonly apiKey?: string;
}

/** Every decision-model connection the config file declares right now. */
export interface GuideConnections {
	readonly providers: readonly GuideProviderConnection[];
	readonly overrides: readonly GuideConnectionOverride[];
}

/** One classifier probe: the connection plus the model id to exercise. */
export interface GuideProbe {
	readonly baseUrl: string;
	readonly apiKey?: string;
	readonly provider: string;
	readonly id: string;
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

/** The result of one dispatched command verb. */
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
	/** The decision-model connections the config file declares right now. */
	readonly connections: () => GuideConnections;
	/**
	 * Probe one classifier connection: one SystemOne request exercising choice,
	 * score and noul. Injected so tests script it and never touch the network;
	 * hosts bind it to the core `probeLocalClassifier`.
	 */
	readonly probeClassifier: (connection: GuideProbe) => Promise<ProbeResult>;
	/** Run one command verb, e.g. `chain-add auto zai/glm-5.3-flash`. */
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

/** The decision-model picker's "type an address" escape (not a real address). */
export const ENTER_ADDRESS = "__enter-address__";

/** The top menu's decision-providers submenu sentinel (not a chain id). */
export const PROVIDERS_MENU = "__decision-providers__";

/**
 * The guide's connection rows as the core resolver sees them, so "is this
 * address connected?" cannot drift from what the router actually resolves.
 */
function connectionSource(connections: GuideConnections): {
	readonly decisionModels?: Readonly<Record<string, { readonly baseUrl?: string }>>;
	readonly decisionProviders?: Readonly<Record<string, { readonly baseUrl?: string }>>;
} {
	return {
		...(connections.overrides.length === 0
			? {}
			: {
					decisionModels: Object.fromEntries(
						connections.overrides.map((entry) => [
							entry.address,
							{ ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }) },
						]),
					),
				}),
		...(connections.providers.length === 0
			? {}
			: {
					decisionProviders: Object.fromEntries(
						connections.providers.map((entry) => [
							entry.provider,
							{ ...(entry.baseUrl === undefined ? {} : { baseUrl: entry.baseUrl }) },
						]),
				),
			}),
	};
}

/**
 * The raw row an address resolves to: its own `decisionModels` entry first,
 * else the provider's - the same precedence the core resolves with (an
 * override wins wholly; it never merges with the provider row).
 */
function connectionRow(
	connections: GuideConnections,
	address: string,
): GuideProviderConnection | GuideConnectionOverride | undefined {
	const override = connections.overrides.find((entry) => entry.address === address);
	if (override !== undefined) return override;
	const slash = address.indexOf("/");
	if (slash <= 0) return undefined;
	const provider = address.slice(0, slash);
	return connections.providers.find((entry) => entry.provider === provider);
}

/** One connection row's picker description. */
function connectionDescription(entry: GuideProviderConnection | GuideConnectionOverride): string {
	return [entry.baseUrl ?? "no baseUrl", `key ${entry.apiKey ?? "local"}`].join(" · ");
}

/**
 * Picker options for addresses the catalog cannot offer but the file can
 * still classify with: per-address `decisionModels` overrides, plus decision
 * models already referenced by a chain whose provider has an entry. OpenCode
 * has no classifier catalog, so without this row a connected address would be
 * unreachable from the picker.
 */
function connectedOptions(ports: GuidePorts): GuideOption<string>[] {
	const connections = ports.connections();
	const known = new Set(ports.models().map((model) => model.address));
	const options = new Map<string, GuideOption<string>>();
	const add = (address: string, entry: GuideProviderConnection | GuideConnectionOverride) => {
		if (known.has(address) || options.has(address)) return;
		options.set(address, { title: address, value: address, description: connectionDescription(entry) });
	};
	for (const override of connections.overrides) add(override.address, override);
	for (const chain of ports.chains()) {
		const address = chain.decisionModel;
		if (address === undefined) continue;
		const slash = address.indexOf("/");
		if (slash <= 0) continue;
		const entry = connections.providers.find((provider) => provider.provider === address.slice(0, slash));
		if (entry !== undefined) add(address, entry);
	}
	return [...options.values()];
}

/** Probe one address with its resolved connection and report the outcome. */
async function probeAndReport(ports: GuidePorts, address: string): Promise<void> {
	const parts = splitDecisionModelAddress(address);
	if (parts === undefined) {
		ports.say(`switchback: "${address}" is not a "provider/model" address`, "warning");
		return;
	}
	const row = connectionRow(ports.connections(), address);
	const baseUrl = row?.baseUrl;
	if (baseUrl === undefined) {
		ports.say(`switchback: ${address} has no baseUrl to test`, "warning");
		return;
	}
	const apiKey = row?.apiKey;
	let result: ProbeResult;
	try {
		result = await ports.probeClassifier({
			baseUrl,
			provider: parts.provider,
			id: parts.id,
			...(apiKey === undefined ? {} : { apiKey }),
		});
	} catch (error) {
		ports.say(
			`switchback: cannot reach ${baseUrl} - ${error instanceof Error ? error.message : String(error)}`,
			"error",
		);
		return;
	}
	ports.say(
		formatProbeReport({ label: `${parts.provider}/${parts.id} at ${baseUrl}`, result }),
		result.ok ? "success" : "warning",
	);
}

/**
 * After a decision model lands, offer the quick capability check. A connected
 * address gets one probe request; an address with no connection details gets a
 * one-line warning that names the way out (the Decision providers menu),
 * because OpenCode has no classifier catalog to resolve it.
 */
async function offerQuickProbe(ports: GuidePorts, address: string): Promise<void> {
	const connection = decisionModelConnection(connectionSource(ports.connections()), address);
	if (connection?.baseUrl === undefined) {
		ports.say(
			`switchback: ${address} has no connection details yet - OpenCode has no classifier catalog, so this address cannot classify; connect it under "Decision providers"`,
			"warning",
		);
		return;
	}
	const confirmed = await ports.dialog.confirm({
		title: `test ${address} now?`,
		message: "one request exercises choice, score and noul against the configured endpoint.",
	});
	if (confirmed !== true) return;
	await probeAndReport(ports, address);
}

/** The decision-model menu: pick a classifier, enter an address, or turn it off. */
async function editDecisionModel(ports: GuidePorts, chain: GuideChain): Promise<void> {
	const current = chain.decisionModel;
	const picked = await ports.dialog.select<string | null>({
		title: `decision model for ${chain.id}`,
		placeholder: "type to search, pick 'off', or enter an address",
		options: [
			{ title: "off", value: null, description: "cycle blindly when no classifier is configured" },
			...modelOptions(ports.models()),
			...connectedOptions(ports),
			{ title: "Enter an address...", value: ENTER_ADDRESS, description: 'a "provider/model" id, e.g. ollama/jev' },
		],
		current: current ?? null,
		search: (query, options) => {
			if (query.trim().length === 0) return options;
			// Keep the "off" escape and the address escape reachable whatever the query is.
			const pinned = options.filter(
				(option) => option.value === null || option.value === ENTER_ADDRESS,
			);
			const rest = options.filter(
				(option) => option.value !== null && option.value !== ENTER_ADDRESS,
			) as readonly GuideOption<string>[];
			return [...pinned, ...searchModelOptions(query, rest)];
		},
	});
	if (picked === undefined) return;
	if (picked === null) {
		await dispatch(ports, `decision-model ${chain.id} off`);
		return;
	}
	let address = picked;
	if (picked === ENTER_ADDRESS) {
		const typed = await ports.dialog.prompt({
			title: "decision model address",
			description: 'a "provider/model" id; connect the provider first when it is not in the catalog',
			placeholder: "ollama/jev",
			value: current ?? "",
		});
		if (typed === undefined) return;
		const trimmed = typed.trim();
		if (splitDecisionModelAddress(trimmed) === undefined) {
			ports.say(`switchback: "${trimmed}" is not a "provider/model" address`, "warning");
			return;
		}
		address = trimmed;
	}
	if (!(await dispatch(ports, `decision-model ${chain.id} ${address}`))) return;
	await offerQuickProbe(ports, address);
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

/** One provider's summary line: endpoint, key, and how many models it serves. */
function providerSummary(entry: GuideProviderConnection, usedBy: number): string {
	return [
		entry.baseUrl ?? "no baseUrl",
		`key ${entry.apiKey ?? "local"}`,
		usedBy === 0 ? "no models yet" : `used by ${usedBy} model${usedBy === 1 ? "" : "s"}`,
	].join(" · ");
}

/** How many chains classify with a decision model from this provider. */
function providerUseCount(chains: readonly GuideChain[], provider: string): number {
	return chains.filter((chain) => {
		const address = chain.decisionModel;
		if (address === undefined) return false;
		const slash = address.indexOf("/");
		return slash > 0 && address.slice(0, slash) === provider;
	}).length;
}

/**
 * Ask for a connection's endpoint and api key mode, prefilled from `current`.
 * Empty key input means "local"; shape errors are left to the verb, which owns
 * validation - the menu never invents its own rules.
 */
async function promptConnection(
	ports: GuidePorts,
	current: GuideProviderConnection,
): Promise<{ readonly baseUrl: string; readonly key: string } | undefined> {
	const baseUrl = await ports.dialog.prompt({
		title: "baseUrl",
		description: "the SystemOne endpoint every decision model of this provider uses",
		placeholder: "http://localhost:11434",
		value: current.baseUrl ?? "",
	});
	if (baseUrl === undefined) return undefined;
	const trimmedUrl = baseUrl.trim();
	if (trimmedUrl.length === 0) {
		ports.say("switchback: a baseUrl cannot be empty - a provider entry needs an endpoint", "warning");
		return undefined;
	}
	const key = await ports.dialog.prompt({
		title: "api key",
		description: '"local" for a local server, or "secret:<name>" to read the key from the environment',
		placeholder: "local",
		value: current.apiKey ?? "local",
	});
	if (key === undefined) return undefined;
	const trimmedKey = key.trim();
	return { baseUrl: trimmedUrl, key: trimmedKey.length === 0 ? "local" : trimmedKey };
}

/** Create a provider connection: id, endpoint, then the api key mode. */
async function addProvider(ports: GuidePorts): Promise<void> {
	const provider = await ports.dialog.prompt({
		title: "provider id",
		description: 'the first half of a "provider/model" address, e.g. ollama',
		placeholder: "ollama",
	});
	if (provider === undefined) return;
	const trimmed = provider.trim();
	if (trimmed.length === 0) {
		ports.say("switchback: a provider id cannot be empty", "warning");
		return;
	}
	const connection = await promptConnection(ports, { provider: trimmed });
	if (connection === undefined) return;
	await dispatch(ports, `provider ${trimmed} ${connection.baseUrl} ${connection.key}`);
}

/** Probe one model id against a provider's connection. */
async function testProvider(ports: GuidePorts, entry: GuideProviderConnection): Promise<void> {
	if (entry.baseUrl === undefined) {
		ports.say(`switchback: ${entry.provider} has no baseUrl to test`, "warning");
		return;
	}
	const typed = await ports.dialog.prompt({
		title: `model id to test on ${entry.provider}`,
		description: 'the id half of the address; a pasted "provider/model" works too',
		placeholder: "jev",
	});
	if (typed === undefined) return;
	let id = typed.trim();
	if (id.startsWith(`${entry.provider}/`)) id = id.slice(entry.provider.length + 1);
	if (id.length === 0 || id.includes("/")) {
		ports.say(`switchback: "${typed.trim()}" is not a model id for ${entry.provider}`, "warning");
		return;
	}
	await probeAndReport(ports, `${entry.provider}/${id}`);
}

/** One provider's menu: edit its connection, test it, or remove it. */
async function editProvider(ports: GuidePorts, providerId: string): Promise<void> {
	for (;;) {
		const entry = ports.connections().providers.find((provider) => provider.provider === providerId);
		if (entry === undefined) {
			ports.say(`switchback: ${providerId} is no longer configured`, "warning");
			return;
		}
		const action = await ports.dialog.select<"connection" | "test" | "remove" | "back">({
			title: entry.provider,
			options: [
				{
					title: "Edit connection",
					value: "connection",
					description: providerSummary(entry, providerUseCount(ports.chains(), entry.provider)),
				},
				{ title: "Test", value: "test", description: "probe one model id against this endpoint" },
				{ title: "Remove", value: "remove" },
				{ title: "Back", value: "back" },
			],
		});
		if (action === undefined || action === "back") return;
		switch (action) {
			case "connection": {
				const connection = await promptConnection(ports, entry);
				if (connection !== undefined) {
					await dispatch(ports, `provider ${entry.provider} ${connection.baseUrl} ${connection.key}`);
				}
				break;
			}
			case "test":
				await testProvider(ports, entry);
				break;
			case "remove": {
				const usedBy = providerUseCount(ports.chains(), entry.provider);
				const confirmed = await ports.dialog.confirm({
					title: `remove ${entry.provider}?`,
					message:
						usedBy === 0
							? "its connection details will be removed from switchback.yaml."
							: `${usedBy} model${usedBy === 1 ? "" : "s"} classify with ${entry.provider}; without the entry they cannot classify.`,
				});
				if (confirmed === true) {
				await dispatch(ports, `provider-remove ${entry.provider}`);
				return;
				}
				break;
			}
		}
	}
}

/** The decision-providers submenu: list, add, then per-provider edit/test/remove. */
export async function editProviders(ports: GuidePorts): Promise<void> {
	for (;;) {
		const providers = ports.connections().providers;
		const choice = await ports.dialog.select<string>({
			title: "decision providers",
			placeholder: providers.length === 0 ? "no providers connected yet" : "type to filter providers",
			options: [
				...providers.map((entry) => ({
					title: entry.provider,
					value: entry.provider,
					description: providerSummary(entry, providerUseCount(ports.chains(), entry.provider)),
				})),
				{ title: "Add a provider", value: "add", description: "connect a provider's decision models" },
				{ title: "Back", value: "back" },
			],
		});
		if (choice === undefined || choice === "back") return;
		if (choice === "add") {
			await addProvider(ports);
			continue;
		}
		await editProvider(ports, choice);
	}
}

/** The top menu: pick a chain, add one, manage connections, or leave. */
export async function runGuide(ports: GuidePorts): Promise<void> {
	for (;;) {
		const chains = ports.chains();
		const providers = ports.connections().providers;
		const choice = await ports.dialog.select<string | null>({
			title: "switchback configuration",
			placeholder: chains.length === 0 ? "no chains configured yet" : "type to filter chains",
			options: [
				...chains.map((chain) => ({
					title: chainTitle(chain),
					value: chain.id as string | null,
					description: chainDescription(chain),
				})),
				{
					title: "Decision providers",
					value: PROVIDERS_MENU,
					description:
						providers.length === 0
							? "no connections yet"
							: `${providers.length} connected`,
				},
				{ title: "Add a chain", value: null, description: "create a new virtual model" },
			],
		});
		if (choice === undefined) return;
		if (choice === null) {
			await addChain(ports);
			continue;
		}
		// A chain named like the sentinel would shadow the submenu entry; the
		// chains still open through the per-chain menu of any other chain.
		if (choice === PROVIDERS_MENU && !chains.some((chain) => chain.id === PROVIDERS_MENU)) {
			await editProviders(ports);
			continue;
		}
		await editChain(ports, choice);
	}
}
