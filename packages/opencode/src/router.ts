/**
 * The plugin side of the bridge: turns OpenCode host context (catalog,
 * credentials, shared config) into `PhysicalEntry` lists and answers the
 * provider package's routing questions with the core router's decisions.
 *
 * This is pi's `route()` callback transplanted: `decide()` receives a
 * structurally-compatible request (pi types stay type-only), keeps its state
 * per conversation key, and its outcome maps 1:1 to the cascade's vocabulary -
 * `ok` dispatches, `config-invalid`/`exhausted` surface as errors.
 */

import type { Plugin } from "@opencode/plugin";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import {
	createConfigWarningReporter,
	decide,
	effectiveIds,
	findModelConfig,
	loadConfig,
	readBlockedMap,
	readDisabledMap,
	resolveFallbacks,
	systemOneClassifierPort,
} from "switchback-core";
import type {
	ResolvedSwitchbackConfig,
	ResolvedSwitchbackFileConfig,
	RouterRegistryPort,
	SecretResolver,
	SwitchbackState,
} from "switchback-core";
import type { PhysicalEntry, RouteAnswer, RouteCall, SwitchbackBridge } from "./bridge.ts";
import { catalogPort, findInCatalog, opencodeThinkingSupport, providerModuleFor } from "./catalog.ts";
import type { CatalogModel } from "./catalog.ts";
import { publishNotice } from "./notices.ts";

/** `secret:<name>` refs resolve against the environment (no readable vault). */
const envSecrets: SecretResolver = { get: (name) => process.env[name] };

/** Warns once per distinct loader finding; this module reads per request. */
const reportConfigWarnings = createConfigWarningReporter();

/** How long a resolved credential/provider-settings pair is reused. */
const ENTRY_TTL_MS = 60_000;

export interface RouterOptions {
	readonly ctx: Plugin.Context;
	/** The configured chain ids the plugin published as virtual models. */
	readonly chains: readonly string[];
}

/**
 * Build the bridge. The returned object owns the per-conversation router state
 * (in-process by design: pi stores it on the session branch, which OpenCode
 * does not expose; blocks stay account-scoped in `blocks.json` regardless).
 */
export function createRouter(options: RouterOptions): SwitchbackBridge {
	const { ctx, chains } = options;
	const states = new Map<string, SwitchbackState>();
	let configNotified = false;

	const loadConfigSafe = (): ResolvedSwitchbackFileConfig | undefined => {
		try {
			const loaded = loadConfig(envSecrets);
			configNotified = false;
			reportConfigWarnings(loaded.warnings, (message) => notifyAll(message));
			return loaded.config;
		} catch (error) {
			if (!configNotified) {
				configNotified = true;
				notifyAll(
					`switchback disabled (config problem): ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			return undefined;
		}
	};

	const notifyAll = (message: string): void => {
		// Fan-out without a session handle: the provider package always supplies
		// a session key, so this path only fires for setup-time problems.
		for (const sessionID of states.keys()) {
			void ctx.session.synthetic({ sessionID, text: message }).catch(() => {
				// Nothing the routing decision can use; swallow.
			});
		}
	};

	const readCatalog = async (): Promise<CatalogModel[]> => (await ctx.model.list()).data as unknown as CatalogModel[];

	const registryFor = (
		catalog: readonly CatalogModel[],
		decisionModel: ResolvedSwitchbackConfig["decisionModel"],
	): RouterRegistryPort => ({
		...catalogPort(catalog),
		...systemOneClassifierPort({
			baseUrl: decisionModel?.baseUrl,
			...(decisionModel?.apiKey !== undefined ? { apiKey: decisionModel.apiKey } : {}),
			identity: { provider: decisionModel?.provider ?? "", id: decisionModel?.id ?? "" },
		}),
	});

	// Credential + settings cache: modelId -> {settings, at}.
	const entryCache = new Map<string, { readonly settings: PhysicalEntry["settings"]; readonly at: number }>();

	const resolveEntrySettings = async (modelId: string): Promise<PhysicalEntry["settings"]> => {
		const cached = entryCache.get(modelId);
		if (cached !== undefined && Date.now() - cached.at < ENTRY_TTL_MS) return cached.settings;
		const address = split(modelId);
		if (address === undefined) return {};
		const catalog = await readCatalog();
		const info = findInCatalog(catalog, address.provider, address.modelID);
		const providerSettings = (await ctx.provider.list()).data.find((p) => p.id === address.provider)?.settings;
		let apiKey: string | undefined;
		try {
			const connection = await ctx.integration.connection.active(address.provider);
			if (connection === undefined) {
				console.error(`[switchback] no active connection for ${address.provider}`);
			}
			const credential =
				connection === undefined ? undefined : await ctx.integration.connection.resolve(connection);
			if (credential?.type === "key") apiKey = credential.key;
		} catch (error) {
			console.error(`[switchback] credential lookup failed for ${address.provider}:`, error);
			// No stored connection: config/settings carry the key or the request
			// fails visibly at dispatch - nothing to fabricate here.
		}
		const merged: PhysicalEntry["settings"] = {
			...(providerSettings ?? {}),
			...(info?.settings ?? {}),
			...(apiKey !== undefined ? { apiKey } : {}),
		};
		entryCache.set(modelId, { settings: merged, at: Date.now() });
		return merged;
	};

	const bridge: SwitchbackBridge = {
		async route(call: RouteCall): Promise<RouteAnswer> {
			const now = Date.now();
			const config = loadConfigSafe();
			if (config === undefined) {
				return { status: "config-invalid", message: "switchback: config could not be loaded" };
			}
			const chain = findModelConfig(config, call.chainId);
			if (chain === undefined) {
				return {
					status: "config-invalid",
					message: `switchback: chain "${call.chainId}" is not configured (configured: ${chains.join(", ") || "none"})`,
				};
			}
			const catalog = await readCatalog();
			const registry = registryFor(catalog, chain.decisionModel);
			const blocked = readBlockedMap(now);
			const disabled = readDisabledMap();
			const priorState = states.get(call.sessionKey);
			const priorCurrent = priorState?.current;
			const request: ModelRouteRequest<SwitchbackState> = {
				model: stub(`${"switchback"}/${call.chainId}`),
				thinkingLevel: call.level ?? "off",
				reason: call.reason,
				...(call.reason === "retry" && call.failed !== undefined
					? {
							failed: {
								model: stub(call.failed.modelId),
								message: assistantStub(call.failed.message, now),
							},
						}
					: {}),
				...(priorState !== undefined ? { state: priorState } : {}),
				messages: await conversationMessages(ctx, call.sessionKey),
			};
			const outcome = await decide(call.reason, request, chain, registry, {
				now,
				blocked,
				disabled,
				support: opencodeThinkingSupport(catalog),
				notify: (message, type) => bridge.notify(call.sessionKey, message, type),
				...((await contextTokensFor(ctx, call.sessionKey)) ?? {}),
				...(config.debug === true ? { debug: true } : {}),
			});
			if (outcome.decision.kind === "config-invalid") {
				const resolved = resolveFallbacks(chain.fallbacks, registry);
				const greyed = resolved.entries
					.filter((e) => e.availability !== "effective")
					.map((e) => `${e.id}:${e.reason ?? e.availability}`);
				return {
					status: "config-invalid",
					message: `switchback: config invalid (${outcome.decision.reason}); effective=[${effectiveIds(resolved).join(", ")}] greyed=[${greyed.join(", ")}]`,
				};
			}
			if (outcome.decision.kind === "exhausted") {
				return { status: "exhausted", message: `switchback: ${outcome.decision.reason} (${chain.id})` };
			}
			if (outcome.nextState !== undefined) states.set(call.sessionKey, outcome.nextState);
			// Announce a model change in-band (synthetic session message): the host's
			// only other channel is the retry hook, which quota errors never reach.
			if (outcome.decision.kind === "switch") {
				bridge.notify(
					call.sessionKey,
					`switchback: ${priorCurrent ?? "(start)"} -> ${outcome.decision.modelId} (${outcome.decision.reason})`,
					"info",
				);
			}
			return {
				status: "ok",
				current: outcome.decision.modelId,
				level: outcome.thinkingLevel,
				state: outcome.nextState ?? { current: outcome.decision.modelId, transientRetries: 0 },
			};
		},

		async entries(chainId: string): Promise<readonly PhysicalEntry[]> {
			const config = loadConfigSafe();
			const chain = config === undefined ? undefined : findModelConfig(config, chainId);
			if (chain === undefined) return [];
			const catalog = await readCatalog();
			const entries: PhysicalEntry[] = [];
			for (const modelId of chain.fallbacks) {
				const address = split(modelId);
				if (address === undefined) continue;
				const info = findInCatalog(catalog, address.provider, address.modelID);
				if (info === undefined || info.enabled === false) continue;
				const settings = await resolveEntrySettings(modelId);
				entries.push({
					modelId,
					providerModule: providerModuleFor(info.package),
					modelID: info.modelID,
					name: info.name,
					settings,
					contextWindow: info.limit?.context ?? 0,
				});
			}
			return entries;
		},

		notify(sessionKey, message, type) {
			// An attached client gets a toast; otherwise the transcript carries it.
			if (publishNotice({ sessionID: sessionKey, message, variant: type })) return;
			void ctx.session.synthetic({ sessionID: sessionKey, text: message }).catch(() => {
				// Nothing the routing decision can use; swallow.
			});
		},

		debug: () => loadConfigSafe()?.debug === true,
	};
	return bridge;
}

/** "provider/modelID" halves; undefined otherwise. */
function split(modelId: string): { provider: string; modelID: string } | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) return undefined;
	return { provider: modelId.slice(0, slash), modelID: modelId.slice(slash + 1) };
}

/**
 * The conversation shape `idleMsSince` reads: it only consults message
 * timestamps. The host reports the newest one, so a single synthetic message
 * carries it - fabricating the whole transcript would buy nothing and would
 * have to model every OpenCode message variant.
 */
async function conversationMessages(ctx: Plugin.Context, sessionKey: string): Promise<readonly Message[]> {
	const newest = await newestMessageCreated(ctx, sessionKey);
	if (newest === undefined) return [];
	return [{ role: "user", content: "", timestamp: newest } as Message];
}

/**
 * Approximate context usage the way pi's `ctx.getContextUsage()` reports it:
 * the newest assistant message's input tokens plus whatever it read from the
 * prompt cache is the size of the context that request carried. Absent when
 * the host reports no tokens yet (first request of a session).
 */
async function contextTokensFor(
	ctx: Plugin.Context,
	sessionKey: string,
): Promise<{ contextTokens: number } | undefined> {
	const messages = await readMessages(ctx, sessionKey);
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const tokens = (messages[index] as { tokens?: { input?: number; cache?: { read?: number } } } | undefined)
			?.tokens;
		if (tokens === undefined) continue;
		const input = tokens.input ?? 0;
		const cached = tokens.cache?.read ?? 0;
		if (input + cached > 0) return { contextTokens: input + cached };
	}
	return undefined;
}

/** Timestamp (ms) of the newest message the host holds, if it reports one. */
async function newestMessageCreated(ctx: Plugin.Context, sessionKey: string): Promise<number | undefined> {
	const messages = await readMessages(ctx, sessionKey);
	let newest: number | undefined;
	for (const message of messages) {
		const created = (message as { time?: { created?: unknown } } | undefined)?.time?.created;
		const value = created instanceof Date ? created.getTime() : typeof created === "number" ? created : undefined;
		if (value === undefined || !Number.isFinite(value) || value <= 0) continue;
		if (newest === undefined || value > newest) newest = value;
	}
	return newest;
}

/**
 * The session's message list, or an empty list. A failed read (deleted
 * session, transient host error) must never break routing: both consumers
 * treat "no data" as "unknown" and route exactly as before.
 */
async function readMessages(ctx: Plugin.Context, sessionKey: string): Promise<readonly unknown[]> {
	try {
		const messages = await (
			ctx.session as unknown as {
				context?: (input: { sessionID: string }) => Promise<readonly unknown[]>;
			}
		).context?.({ sessionID: sessionKey });
		return Array.isArray(messages) ? messages : [];
	} catch {
		return [];
	}
}

/**
 * The pi `Model` stubs decide() reads `provider`/`id` off (routing.ts's
 * `physicalId`). pi passes its own records; the cast is the one place the
 * adapter fabricates pi shapes.
 */
function stub(modelId: string): ModelRouteRequest<SwitchbackState>["model"] {
	const address = split(modelId);
	return {
		provider: address?.provider ?? modelId,
		id: address?.modelID ?? modelId,
		name: modelId,
		api: "switchback",
		contextWindow: 0,
	} as unknown as ModelRouteRequest<SwitchbackState>["model"];
}

/**
 * Minimal AssistantMessage for classifyError: only `errorMessage` (and an
 * absent stopReason) are read - the same fixture shape `simulate.ts` builds.
 */
function assistantStub(message: string, now: number): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "switchback",
		provider: "switchback",
		model: "failed",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: message,
		timestamp: now,
	} as AssistantMessage;
}
