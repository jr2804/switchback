/**
 * OpenCode V2 plugin for switchback - quota-aware model fallback routing.
 *
 * pi resolves the router's virtual model per request and re-routes provider
 * failures in flight. OpenCode cannot re-point a model mid-request (its
 * `model.request` hook only edits baseURL/headers, and its retry policy never
 * retries quota errors), so the same job moves into a provider package:
 *
 *  1. This plugin publishes a `switchback` provider whose catalog entries are
 *     the configured chains (one model per chain, thinking levels as variants).
 *     They appear in OpenCode's model selector like any physical model.
 *  2. Each entry's `package` points at this npm package, so the host resolves
 *     every request through `src/route.ts`'s `model(modelID, settings)`.
 *  3. The route asks the bridge (`src/router.ts` -> core `decide()`) which
 *     physical model serves the request, streams from it, and on a pre-output
 *     failure classifies the error and walks the chain - the same in-flight
 *     cascade pi gets from `registerVirtualModel`.
 *  4. The chat commands (`/switchback`, `-unblock`, `-disable`, `-enable`)
 *     manage the shared account-scoped state.
 *
 * Config, block state and crash corpus are shared with the pi extension
 * unchanged: the shared `switchback.yaml` layers plus the neutral state dir
 * (see `switchback-core/config.ts`; override with SWITCHBACK_DIR).
 */

import { Plugin } from "@opencode/plugin";
import {
	annotateCrash,
	clearDisabled,
	disableModel,
	disabledFilePath,
	enableModel,
	findModelConfig,
	getPinnedModel,
	isDisabled,
	isValidAnnotationClass,
	layerPath,
	loadConfig,
	readBlockedMap,
	readCrashMap,
	readDisabledMap,
	resolveFallbacks,
	setPinnedModel,
	shortHash,
	unblockModel,
	SWITCHBACK_THINKING_LEVELS,
} from "switchback-core";
import type { DisabledMap, ErrorClass, ModelId, ResolvedSwitchbackFileConfig, SecretResolver } from "switchback-core";
import { clearBridge, publishBridge } from "./bridge.ts";
import type { SwitchbackBridge } from "./bridge.ts";
import { splitModelAddress } from "./catalog.ts";
import {
	clearConfigSessions,
	execute as executeConfigCommand,
	layerForSession,
	parseConfigCommand,
	runConfigCommand,
} from "./config-command.ts";
import { attachNoticeSink, detachNoticeSink, publishNotice, resetNoticeChannel, setNoticeChannel } from "./notices.ts";
import { SwitchbackRpc } from "./rpc.ts";
import { readString } from "./rpc.ts";
import { createRouter } from "./router.ts";

/** The provider id the chains are published under. */
export const SWITCHBACK_PROVIDER_ID = "switchback";

/**
 * `secret:<name>` refs resolve against the environment: OpenCode's credential
 * API activates stored profiles but never returns key material. Unresolvable
 * refs surface through `loadConfig` as a visible config problem - same failure
 * mode as pi, different store.
 */
const envSecrets: SecretResolver = {
	get: (name) => process.env[name],
};

export default Plugin.define({
	id: "switchback",
	async setup(ctx) {
		const config = readConfigOr(undefined);
		const chains = config?.models.map((model) => model.id) ?? [];

		// The bridge must exist before any routed request arrives; the provider
		// package reads it through the globalThis symbol (separate module graph).
		const bridge: SwitchbackBridge = createRouter({ ctx, chains });
		publishBridge(bridge);

		// Publish the chains as selector-visible models of the switchback
		// provider. Re-run on every provider reload so config changes land.
		await ctx.provider.transform(async (rawEditor) => {
			try {
				// The host's ProviderEditor generics are brand-heavy; this module only
				// needs the structural slice below (same policy as route.ts's RouteLike).
				interface EditorLike {
					list(): readonly { provider: { readonly id: string } }[];
					models: { set(providerID: string, models: unknown): unknown };
					update(id: string, fn: (info: { activation: string }) => void): unknown;
					add(input: unknown): unknown;
				}
				const editor = rawEditor as unknown as EditorLike;
				// Read the config fresh: a transform also runs on every reload (the guide
				// triggers one after each edit), so the capture from `setup` would go
				// stale the moment a chain is added or removed.
				const current = readConfigOr(undefined)?.models ?? [];
				const models: unknown[] = [];
				for (const chain of current) {
					// Catalog id is provider-relative: the chain id already carries the
					// "switchback/" prefix, so strip it ("switchback/auto" -> "auto").
					const modelId = chain.id.startsWith("switchback/")
						? chain.id.slice("switchback/".length)
						: chain.id;
					const variants = SWITCHBACK_THINKING_LEVELS.map((level) => ({
						id: level,
						settings: { chain: chain.id, switchbackLevel: level },
					}));
					models.push({
						id: modelId,
						modelID: modelId,
						providerID: SWITCHBACK_PROVIDER_ID,
						name: chain.name,
						enabled: true,
						capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
						limit: { context: 0, output: 0 },
						// Model.Info.cost is an array of tier entries; an empty array keeps
						// routing cost-free (pi-side accounting is per physical model).
						cost: [],
						time: { released: 0 },
						status: "active",
						variants,
						package: "opencode-switchback",
					});
				}
				const existing = editor.list().find((record) => record.provider.id === SWITCHBACK_PROVIDER_ID);
				if (existing !== undefined) {
					editor.models.set(SWITCHBACK_PROVIDER_ID, models as unknown as readonly unknown[]);
					editor.update(SWITCHBACK_PROVIDER_ID, (info) => {
						info.activation = "enabled";
					});
				} else {
					editor.add({
						info: {
							id: SWITCHBACK_PROVIDER_ID,
							name: "Switchback",
							activation: "enabled",
							package: "opencode-switchback",
						},
						models: models as unknown as readonly unknown[],
					});
				}
			} catch (error) {
				console.error(
					"[switchback] provider publish failed:",
					error instanceof Error ? (error.stack ?? error.message) : error,
				);
				throw error;
			}
		});

		await ctx.command.transform((editor) => {
			editor.add({
				name: "switchback",
				description: "Show the fallback chains, their resolved availability and the current block state",
				execute: async ({ sessionID }) => {
					await describeStatus(ctx, sessionID);
				},
			});
		});
		await ctx.command.transform((editor) => {
			editor.add({
				name: "switchback-unblock",
				description: "Clear switchback blocks: ALL, or a model address shown by /switchback",
				execute: async ({ sessionID, prompt }) => {
					await runUnblock(ctx, sessionID, prompt.text);
				},
			});
		});
		await ctx.command.transform((editor) => {
			editor.add({
				name: "switchback-disable",
				description: "Keep a model out of every chain until re-enabled: <provider/model>",
				execute: async ({ sessionID, prompt }) => {
					await runDisable(ctx, sessionID, prompt.text);
				},
			});
			editor.add({
				name: "switchback-enable",
				description: "Re-enable a manually disabled model: <provider/model>, or ALL",
				execute: async ({ sessionID, prompt }) => {
					await runEnable(ctx, sessionID, prompt.text);
				},
			});
		});
		await ctx.command.transform((editor) => {
			editor.add({
				name: "switchback-next",
				description: "Cycle the pin to the next fallback of this chain (pin off to start)",
				execute: async ({ sessionID }) => {
					await runNextPin(ctx, sessionID);
				},
			});
			editor.add({
				name: "switchback-model",
				description: "Pin this chain to one fallback, or clear the pin: [<provider/model>|auto]",
				execute: async ({ sessionID, prompt }) => {
					await runPinModel(ctx, sessionID, prompt.text);
				},
			});
		});
		await ctx.command.transform((editor) => {
			editor.add({
				name: "switchback-config",
				description:
					"Edit switchback.yaml (add/remove models, fallback order, idle-reset, decision model): /switchback-config help",
				execute: async ({ sessionID, prompt }) => {
					await runConfigCommand(sessionID, prompt.text, {
						say: async (text) => {
							if (publishNotice({ sessionID, message: text, variant: "info" })) return;
							await ctx.session.synthetic({ sessionID, text }).catch(() => {
								// Same best-effort rule as notify.
							});
						},
					});
				},
			});
		});
		await ctx.command.transform((editor) => {
			editor.add({
				name: "switchback-blocked",
				description: "List models currently blocked by the switchback router",
				execute: async ({ sessionID }) => {
					await runListBlocked(ctx, sessionID);
				},
			});
			editor.add({
				name: "switchback-crashes",
				description: "List the most-recent N crash entries (default 10)",
				execute: async ({ sessionID, prompt }) => {
					await runListCrashes(ctx, sessionID, prompt.text);
				},
			});
			editor.add({
				name: "switchback-annotate",
				description: "Annotate a crash with a confirmed class: <hash-prefix> <class> [note...]",
				execute: async ({ sessionID, prompt }) => {
					await runAnnotate(ctx, sessionID, prompt.text);
				},
			});
		});

		// Notices reach an attached client (TUI toast today, GUI later) through
		// this RPC; with nothing attached they keep going to the transcript.
		const registration = await ctx.rpc.register(SwitchbackRpc, {
			attach: async () => ({ attached: attachNoticeSink() }),
			detach: async () => ({ attached: detachNoticeSink() }),
			// The interactive guide reads its menu from here, so the server stays the
			// only place that parses `switchback.yaml` and the model catalog.
			state: async (input: unknown) => guideState(ctx, readString(input, "sessionID")),
			// And it edits by sending layer-1 verb text, so the menu and the typed
			// command go through the same grammar and the same writer.
			config: async (input: unknown) => {
				const text = readString(input, "text") ?? "";
				const key = readString(input, "sessionID") ?? "rpc";
				const result = executeConfigCommand(key, parseConfigCommand(text));
				if (result.ok)
					await republish(ctx).catch(() => {
						// Republishing is best effort; the edit itself already landed.
					});
				return { ok: result.ok, text: result.text };
			},
		});
		setNoticeChannel((notice) => {
			void registration.events.emit("notice", {
				...(notice.sessionID === undefined ? {} : { sessionID: notice.sessionID }),
				message: notice.message,
				variant: notice.variant,
			});
		});

		return () => {
			clearBridge();
			clearConfigSessions();
			resetNoticeChannel();
		};
	},
});

/** Read the shared config; a failure is reported lazily by the router. */
function readConfigOr(fallback: ResolvedSwitchbackFileConfig | undefined): ResolvedSwitchbackFileConfig | undefined {
	try {
		return loadConfig(envSecrets).config;
	} catch {
		return fallback;
	}
}

/** Read the shared config once per command; on a config failure the notice is fan-out-safe. */
function readConfig(ctx: Plugin.Context, sessionID: string): ResolvedSwitchbackFileConfig | undefined {
	try {
		return loadConfig(envSecrets).config;
	} catch (error) {
		notify(
			ctx,
			sessionID,
			`switchback disabled for this attempt (config problem): ${error instanceof Error ? error.message : String(error)}`,
		);
		return undefined;
	}
}

const seenNotifications = new Map<string, Set<string>>();

/**
 * Chat-side notice, one per session-per message (a process-lifetime best
 * effort) so a long-lived session does not spam the conversation. Prefers an
 * attached client's toast surface; the transcript is the fallback. Never
 * blocks: a failed write stays a failed write.
 */
function notify(ctx: Plugin.Context, sessionID: string, message: string): void {
	const seen = seenNotifications.get(sessionID);
	if (seen?.has(message) === true) return;
	seenNotifications.set(sessionID, new Set([...(seen ?? []), message]));
	say(ctx, sessionID, message, "info");
}

/**
 * Route one notice to the best available surface: an attached client if there
 * is one, else the transcript.
 */
function say(
	ctx: Plugin.Context,
	sessionID: string,
	message: string,
	variant: "info" | "success" | "warning" | "error",
): void {
	if (publishNotice({ sessionID, message, variant })) return;
	void ctx.session.synthetic({ sessionID, text: message }).catch(() => {
		// Nothing the routing decision can use; swallow.
	});
}

/**
 * The `/switchback` dialog: every chain, every fallback, resolved against the
 * current catalog and live block state.
 */
async function describeStatus(ctx: Plugin.Context, sessionID: string): Promise<void> {
	const config = readConfig(ctx, sessionID);
	if (config === undefined) return;
	if (config.models.length === 0) {
		await ctx.session.synthetic({ sessionID, text: "switchback: no virtual models configured" });
		return;
	}
	const catalog = (await ctx.model.list()).data;
	const availability = catalogPort(catalog);
	const blocked = readBlockedMap(Date.now());
	const disabled = readDisabledMap();
	const sections = config.models.map((model) => {
		const resolved = resolveFallbacks(model.fallbacks, availability);
		const rows = resolved.entries.map((entry) => {
			const until = blocked[entry.id];
			const state = isDisabled(entry.id, disabled)
				? "disabled by hand (enable with /switchback-enable)"
				: entry.availability === "effective"
					? until !== undefined
						? `blocked until ${new Date(until).toISOString()}`
						: "available"
					: `unavailable (${entry.reason ?? entry.availability})`;
			return `  - ${entry.id}: ${state}`;
		});
		return `${model.id} (${model.name}): \n${rows.join("\n")}`;
	});
	const disabledLine = describeDisabled(disabled);
	await ctx.session
		.synthetic({
			sessionID,
			text: `switchback: ${config.models.length} configured chain(s)\n\n${sections.join("\n\n")}${disabledLine}`,
		})
		.catch(() => {
			// Same best-effort rule as notify.
		});
}

/**
 * Every fallback address the config lists, in chain order and deduplicated.
 * The disable/enable commands accept exactly these addresses.
 */
function configuredAddresses(config: ResolvedSwitchbackFileConfig): ModelId[] {
	const seen = new Set<ModelId>();
	for (const model of config.models) for (const id of model.fallbacks) seen.add(id);
	return [...seen];
}

/** Match an argument to a configured address, case-insensitively. */
function resolveAddress(config: ResolvedSwitchbackFileConfig, argument: string): ModelId | undefined {
	const upper = argument.toUpperCase();
	return configuredAddresses(config).find((id) => id.toUpperCase() === upper);
}

/** The trailing "disabled by hand" block of `/switchback`; empty when nothing is disabled. */
function describeDisabled(disabled: DisabledMap): string {
	const ids = Object.keys(disabled).sort();
	return ids.length === 0 ? "" : `\n\ndisabled by hand (${ids.length}): ${ids.join(", ")}`;
}

/**
 * `/switchback-disable <provider/model>`: keep a configured fallback out of
 * every chain until the user enables it again. Written to the state dir rather
 * than switchback.yaml so a regenerated config cannot silently undo it.
 */
async function runDisable(ctx: Plugin.Context, sessionID: string, argument: string | undefined): Promise<void> {
	const target = argument?.trim() ?? "";
	const config = readConfig(ctx, sessionID);
	if (config === undefined) return;
	if (target.length === 0) {
		await describeStatus(ctx, sessionID);
		return;
	}
	const address = resolveAddress(config, target);
	if (address === undefined) {
		const known = configuredAddresses(config);
		notify(
			ctx,
			sessionID,
			`switchback: ${JSON.stringify(target)} is not a configured fallback; known addresses: ${
				known.length === 0 ? "(none)" : known.join(", ")
			}`,
		);
		return;
	}
	const changed = disableModel(address);
	await ctx.session
		.synthetic({
			sessionID,
			text: changed
				? `switchback: disabled ${address} (${disabledFilePath()}) - it stays out of every chain until /switchback-enable ${address}`
				: `switchback: ${address} was already disabled`,
		})
		.catch(() => {
			// Same best-effort rule as notify.
		});
}

/** `/switchback-enable <provider/model|ALL>`: undo a manual disable. */
async function runEnable(ctx: Plugin.Context, sessionID: string, argument: string | undefined): Promise<void> {
	const target = argument?.trim() ?? "";
	const config = readConfig(ctx, sessionID);
	if (config === undefined) return;
	if (target.length === 0) {
		await describeStatus(ctx, sessionID);
		return;
	}
	if (target.toUpperCase() === "ALL") {
		const count = clearDisabled();
		await ctx.session
			.synthetic({
				sessionID,
				text:
					count === 0
						? "switchback: no models were disabled"
						: `switchback: re-enabled ${count} disabled model(s)`,
			})
			.catch(() => {
				// Same best-effort rule as notify.
			});
		return;
	}
	const upper = target.toUpperCase();
	const address =
		resolveAddress(config, target) ?? Object.keys(readDisabledMap()).find((id) => id.toUpperCase() === upper);
	if (address === undefined) {
		notify(
			ctx,
			sessionID,
			`switchback: ${JSON.stringify(target)} is not a configured fallback and was not disabled`,
		);
		return;
	}
	const changed = enableModel(address);
	await ctx.session
		.synthetic({
			sessionID,
			text: changed ? `switchback: re-enabled ${address}` : `switchback: ${address} was not disabled`,
		})
		.catch(() => {
			// Same best-effort rule as notify.
		});
}

/** Clear ALL blocks, or the one matching a model address / id substring. */
async function runUnblock(ctx: Plugin.Context, sessionID: string, argument: string | undefined): Promise<void> {
	const target = argument?.trim() ?? "";
	const config = readConfig(ctx, sessionID);
	if (config === undefined) return;
	if (target.length === 0) {
		await describeStatus(ctx, sessionID);
		return;
	}
	const blocked = readBlockedMap(Date.now());
	const upper = target.toUpperCase();
	const ids =
		upper === "ALL" ? Object.keys(blocked) : Object.keys(blocked).filter((id) => id.toUpperCase() === upper);
	if (ids.length === 0) {
		notify(ctx, sessionID, `switchback: no blocked model matches ${JSON.stringify(target)}; see /switchback`);
		return;
	}
	for (const id of ids) {
		unblockModel(id);
	}
	const remaining = Object.keys(readBlockedMap(Date.now()));
	await ctx.session
		.synthetic({
			sessionID,
			text: `switchback: unblocked ${ids.length} block(s): ${ids.join(", ")}${
				remaining.length === 0 ? "; no blocks left" : `; blocks left: ${remaining.join(", ")}`
			}`,
		})
		.catch(() => {
			// Same best-effort rule as notify.
		});
}

/**
 * The availability port over OpenCode's model catalog for the status dialog.
 * Mirrors `catalog.ts`'s port shape (that one serves the router; this one
 * avoids importing the router's catalog types into the command layer).
 */
function catalogPort(
	catalog: readonly {
		readonly providerID: string;
		readonly modelID: string;
		readonly id: string;
		readonly name: string;
		readonly enabled: boolean | undefined;
		readonly limit?: { readonly context: number } | undefined;
	}[],
) {
	const findIn = (provider: string, modelId: string) => {
		const bare = splitModelAddress(modelId)?.modelId ?? modelId;
		return catalog.find(
			(info) =>
				info.providerID === provider &&
				(info.modelID === modelId || info.modelID === bare || info.id === modelId),
		);
	};
	return {
		find: (provider: string, modelId: string) => {
			const info = findIn(provider, modelId);
			return info === undefined || info.enabled === false
				? undefined
				: {
						provider: info.providerID,
						id: info.modelID,
						name: info.name,
						api: "opencode",
						contextWindow: info.limit?.context ?? 0,
					};
		},
		hasConfiguredAuth: (model: { provider: string; id: string }) => findIn(model.provider, model.id) !== undefined,
		getProviderAuthStatus: (provider: string) =>
			catalog.some((info) => info.providerID === provider)
				? { configured: true }
				: { configured: false, label: `no enabled models for provider "${provider}" in the OpenCode catalog` },
	};
}

// Re-exported for the host's provider-package resolution: the switchback
// provider's catalog entries declare this package, and the host's
// `importPackage` looks for `model(modelID, settings)` on the entrypoint.
export { model } from "./route.ts";

/**
 * Which configured chain the session is using, when it is a switchback one.
 * The pin commands address a chain the way the catalog does, and the host
 * records the selection on the session record (`session.model`).
 */
async function chainOfSession(
	ctx: Plugin.Context,
	sessionID: string,
): Promise<{ chainId: string; config: ResolvedSwitchbackFileConfig } | undefined> {
	try {
		const info = await ctx.session.get({ sessionID });
		const model = (info as { model?: { id?: string; providerID?: string } } | undefined)?.model;
		if (model?.providerID !== SWITCHBACK_PROVIDER_ID || typeof model.id !== "string") return undefined;
		const chainId = model.id.includes("/") ? model.id : `${SWITCHBACK_PROVIDER_ID}/${model.id}`;
		const config = readConfigOr(undefined);
		if (config === undefined) return undefined;
		// A session may still point at a chain that a config edit removed; the
		// commands report that as "no switchback model selected" rather than throw.
		return findModelConfig(config, chainId) === undefined ? undefined : { chainId, config };
	} catch {
		return undefined;
	}
}

/** Post one chat-side notice; the commands do not need the dedupe `notify` adds. */
async function sayNow(ctx: Plugin.Context, sessionID: string, text: string): Promise<void> {
	if (publishNotice({ sessionID, message: text, variant: "info" })) return;
	await ctx.session.synthetic({ sessionID, text }).catch(() => {
		// Same best-effort rule as notify.
	});
}

/**
 * Republish the switchback models from a fresh read of switchback.yaml.
 *
 * `provider.transform` runs on every reload, and it re-reads the config itself,
 * so a reload is all that is needed for a config edit to reach the selector.
 * Both halves are best effort: the edit is already on disk, and the next
 * request resolves the chain from the file regardless of what the selector
 * shows.
 */
async function republish(ctx: Plugin.Context): Promise<void> {
	await ctx.provider.reload();
	await ctx.model.reload();
}

/** Read the merged chains and the catalog for the interactive guide's menu. */
async function guideState(
	ctx: Plugin.Context,
	sessionID: string | undefined,
): Promise<{
	chains: readonly {
		id: string;
		name: string;
		fallbacks: readonly string[];
		idleReset?: string;
		decisionModel?: string;
	}[];
	models: readonly { address: string; name: string; contextWindow?: number; ready: boolean }[];
	path: string;
}> {
	const chainRows: {
		id: string;
		name: string;
		fallbacks: readonly string[];
		idleReset?: string;
		decisionModel?: string;
	}[] = [];
	const config = readConfigOr(undefined);
	for (const model of config?.models ?? []) {
		// The guide speaks `provider/model`, the file holds a parsed decision
		// model, so render it back into the same address form the picker offers.
		const decision = model.decisionModel;
		const decisionAddress = decision === undefined ? undefined : `${decision.provider}/${decision.id}`;
		chainRows.push({
			id: model.id,
			name: model.name,
			fallbacks: [...model.fallbacks],
			...(model.idleReset === undefined ? {} : { idleReset: model.idleReset }),
			...(decisionAddress === undefined ? {} : { decisionModel: decisionAddress }),
		});
	}
	const catalog = await ctx.model.list().catch(() => ({ data: [] as readonly never[] }));
	const models = catalog.data
		.filter((info) => info.enabled !== false)
		.map((info) => {
			const address = `${info.providerID}/${info.modelID}`;
			const contextWindow = info.limit?.context;
			return {
				address,
				name: info.name,
				...(contextWindow === undefined || contextWindow <= 0 ? {} : { contextWindow }),
				ready: true,
			};
		})
		// The guide must never offer a switchback chain as one of its own
		// fallbacks: it would resolve to itself and re-enter the router.
		.filter((model) => !model.address.startsWith(`${SWITCHBACK_PROVIDER_ID}/`));
	return { chains: chainRows, models, path: layerPath(layerForSession(sessionID ?? "rpc")) };
}

/** `/switchback-next`: advance the pin through (none, ...fallbacks) and wrap. */
async function runNextPin(ctx: Plugin.Context, sessionID: string): Promise<void> {
	const found = await chainOfSession(ctx, sessionID);
	if (found === undefined) {
		await sayNow(ctx, sessionID, "switchback: /switchback-next only applies while a switchback model is selected");
		return;
	}
	const { chainId, config } = found;
	const chain = findModelConfig(config, chainId);
	if (chain === undefined) return;
	const choices: ReadonlyArray<ModelId | null> = [null, ...chain.fallbacks];
	const currentPin = getPinnedModel(chainId);
	// Slot 0 is "pin off". With no pin the cycle starts there, so the first
	// press selects the first fallback instead of re-clearing an empty pin.
	const currentIndex = currentPin === undefined ? 0 : Math.max(0, choices.indexOf(currentPin));
	const next = choices[(currentIndex + 1) % choices.length] ?? null;
	setPinnedModel(chainId, next);
	await sayNow(
		ctx,
		sessionID,
		next === null
			? `${chainId}: pin cleared (routing falls back to stickiness and preference)`
			: `${chainId}: pinned to ${next}`,
	);
}

/**
 * `/switchback-model [<provider/model>|auto]`: set the pin directly. With no
 * argument the known choices are listed - the host has no plugin-facing picker
 * API, so the argument is the selection channel.
 */
async function runPinModel(ctx: Plugin.Context, sessionID: string, argument: string | undefined): Promise<void> {
	const found = await chainOfSession(ctx, sessionID);
	if (found === undefined) {
		await sayNow(ctx, sessionID, "switchback: /switchback-model only applies while a switchback model is selected");
		return;
	}
	const { chainId, config } = found;
	const chain = findModelConfig(config, chainId);
	if (chain === undefined) return;
	const target = argument?.trim() ?? "";
	if (target.length === 0) {
		const currentPin = getPinnedModel(chainId);
		const rows = chain.fallbacks.map((id) => `  - ${id}${id === currentPin ? "  (current pin)" : ""}`);
		await sayNow(
			ctx,
			sessionID,
			`${chainId} routes to: ${currentPin ?? "(auto - stickiness and preference)"}\nchoices:\n${rows.join("\n")}\nset one with /switchback-model <provider/model>, or /switchback-model auto to clear`,
		);
		return;
	}
	if (target.toUpperCase() === "AUTO") {
		setPinnedModel(chainId, null);
		await sayNow(ctx, sessionID, `${chainId}: pin cleared`);
		return;
	}
	const address = resolveAddress(config, target);
	if (address === undefined || !chain.fallbacks.includes(address)) {
		await sayNow(ctx, sessionID, `switchback: ${JSON.stringify(target)} is not a fallback of ${chainId}`);
		return;
	}
	setPinnedModel(chainId, address);
	await sayNow(ctx, sessionID, `${chainId}: routes to ${address}`);
}

/** `/switchback-blocked`: live block state with reset times, soonest first. */
async function runListBlocked(ctx: Plugin.Context, sessionID: string): Promise<void> {
	const now = Date.now();
	const entries = Object.entries(readBlockedMap(now))
		.filter(([, until]) => until > now)
		.sort(([, a], [, b]) => a - b);
	if (entries.length === 0) {
		await sayNow(ctx, sessionID, "switchback: (no models currently blocked)");
		return;
	}
	const rows = entries.map(
		([modelId, until]) => `  - ${modelId}  (resets in ${Math.ceil((until - now) / 60_000)} min)`,
	);
	await sayNow(ctx, sessionID, `switchback: blocked models (${entries.length}):\n${rows.join("\n")}`);
}

/** `/switchback-crashes [n]`: the most recent N crash entries (default 10). */
async function runListCrashes(ctx: Plugin.Context, sessionID: string, argument: string | undefined): Promise<void> {
	const count = parseCount(argument, 10);
	if (count === undefined) {
		await sayNow(ctx, sessionID, "switchback: usage: /switchback-crashes [n]");
		return;
	}
	const map = readCrashMap();
	const entries = Object.entries(map)
		.sort(([, a], [, b]) => b.last - a.last)
		.slice(0, count);
	if (entries.length === 0) {
		await sayNow(ctx, sessionID, "switchback: (no crashes recorded yet)");
		return;
	}
	const rows = entries.map(([hash, entry]) => {
		const klass =
			entry.verdict === null ? `no-classifier (${entry.noClassifierReason ?? "?"})` : entry.verdict.class;
		const minutes = Math.max(0, Math.floor((Date.now() - entry.last) / 60_000));
		return `  - ${shortHash(hash)}  ${entry.provider}/${entry.model}  ${klass}  count=${entry.count}  last=${minutes}m ago  action=${entry.action}${entry.annotated === undefined ? "" : "  [annot]"}`;
	});
	await sayNow(
		ctx,
		sessionID,
		`switchback: crashes (${entries.length} of ${Object.keys(map).length} total):\n${rows.join("\n")}`,
	);
}

/** `/switchback-annotate <hash-prefix> <class> [note...]`: write the Tier 2b cache row. */
async function runAnnotate(ctx: Plugin.Context, sessionID: string, argument: string | undefined): Promise<void> {
	const parsed = parseAnnotateArgs(argument ?? "");
	if (parsed === undefined) {
		await sayNow(
			ctx,
			sessionID,
			`switchback: usage: /switchback-annotate <hash-prefix> <class> [note...] (classes: ${ANNOTATION_CLASSES.join(", ")})`,
		);
		return;
	}
	if (!isValidAnnotationClass(parsed.klass)) {
		await sayNow(ctx, sessionID, `switchback: class must be one of: ${ANNOTATION_CLASSES.join(", ")}`);
		return;
	}
	const map = readCrashMap();
	const matches = Object.keys(map).filter((hash) => hash.startsWith(parsed.hash));
	if (matches.length === 0) {
		await sayNow(ctx, sessionID, `switchback: no crash matches hash prefix ${JSON.stringify(parsed.hash)}`);
		return;
	}
	if (matches.length > 1 && !/^[0-9a-f]{8}$/u.test(parsed.hash)) {
		const rows = matches.map((hash) => `  - ${shortHash(hash)}  ${map[hash]?.provider}/${map[hash]?.model}`);
		await sayNow(ctx, sessionID, `switchback: ambiguous prefix; matches:\n${rows.join("\n")}\nuse a longer prefix`);
		return;
	}
	const hash = matches[0];
	if (hash === undefined) return;
	try {
		annotateCrash(hash, parsed.klass, parsed.note ?? "");
	} catch (error) {
		await sayNow(
			ctx,
			sessionID,
			`switchback: annotation failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		return;
	}
	await sayNow(ctx, sessionID, `switchback: annotated ${shortHash(hash)} as ${parsed.klass}`);
}

/** Every class `switchback-annotate` accepts, in menu order (core validates). */
const ANNOTATION_CLASSES: readonly ErrorClass[] = ["quota", "auth", "transient", "overflow", "unknown"];

/** `[n]` argument parser shared by the listing commands. */
function parseCount(argument: string | undefined, fallback: number): number | undefined {
	const trimmed = argument?.trim() ?? "";
	if (trimmed.length === 0) return fallback;
	const parsed = Number(trimmed);
	return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

/** `<hash-prefix> <class> [note...]` parser for `/switchback-annotate`. */
function parseAnnotateArgs(argument: string): { hash: string; klass: ErrorClass; note?: string } | undefined {
	const parts = argument
		.trim()
		.split(/\s+/u)
		.filter((part) => part.length > 0);
	const [hash, klass, ...rest] = parts;
	if (hash === undefined || klass === undefined) return undefined;
	if (!/^[0-9a-f]{4,}$/u.test(hash)) return undefined;
	const note = rest.length > 0 ? rest.join(" ") : undefined;
	return { hash, klass: klass as ErrorClass, ...(note === undefined ? {} : { note }) };
}
