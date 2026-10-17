/**
 * OpenCode V2 plugin for switchback - quota-aware model fallback routing.
 *
 * pi resolves the router's virtual model per request and re-routes provider
 * failures in flight. OpenCode has no virtual-model dispatch, so the same job
 * moves to a turn boundary around the `retry` session hook:
 *
 *  1. OpenCode classifies a failure and proposes its own retry policy; this
 *     hook runs after that decision, before any retry is scheduled.
 *  2. The plugin classifies the error with the shared config's classifier
 *     (switchback.yaml's `jev`) and, per the verdict, updates the shared
 *     account-scoped block state.
 *  3. When the failing model belongs to a configured fallback chain, the
 *     session is switched to the next effective fallback via
 *     `ctx.session.switchModel`, so the retry OpenCode already scheduled runs
 *     on the switched model - the in-flight re-route step wide.
 *  4. When no alternative remains, the hook's `decision` is flipped to
 *     `retry: false` so OpenCode surfaces the failure instead of looping into
 *     blocked models. Every other case keeps OpenCode's own policy untouched.
 *  5. Without a classifier decision nothing is blocked and no verdict is
 *     fabricated (root AGENTS.md rule 1): the sighting lands in the shared
 *     crash corpus and OpenCode's policy runs undetoured.
 *
 * Config, block state and crash corpus are shared with the pi extension
 * unchanged: the shared `switchback.yaml` layers plus the neutral state dir
 * (see `switchback-core/config.ts`; override with SWITCHBACK_DIR).
 */

import { Plugin } from "@opencode/plugin";
import {
	assessFailure,
	loadConfig,
	pickNextEffective,
	readBlockedMap,
	recordDecideCrash,
	resolveFallbacks,
	unblockModel,
	systemOneClassifierPort,
} from "switchback-core";
import type {
	CrashAction,
	HostModel,
	ModelId,
	ResolvedSwitchbackFileConfig,
	RouterRegistryPort,
	AvailabilityPort,
} from "switchback-core";

export default Plugin.define({
	id: "switchback",
	async setup(ctx) {
		// Failure handling first: routing must be live even if a dialog fails to register.
		await ctx.session.hook("retry", (input) => handleRetry(ctx, input));
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
	},
});

/**
 * The retry hook's payload, narrowed to what switchback reads.
 *
 * OpenCode's own record is `SessionRetry` plus `Model.Ref` plus
 * `SessionError.Error` (see @opencode/plugin/dist/promise/session.d.ts) - the
 * plugin never imports the host's types, only structurally compatible shapes.
 * `decision` stays mutable on purpose: it is OpenCode's pending retry policy
 * and the exhausted path flips it to `retry: false`.
 */
interface RetryPayload {
	readonly sessionID: string;
	readonly model: { readonly providerID: string; readonly id: string };
	readonly error: { readonly message: string; readonly response?: { readonly body?: string } | undefined };
	decision: { retry: false } | { retry: true; delay: number };
}

/**
 * Classification + block + advance for one failure OpenCode chose to retry.
 *
 * The failing model must be listed in a configured chain's fallbacks; anything
 * else is untouched (pi behaves the same way: its route only ever runs for the
 * switchback virtual model). Without a chain match OpenCode's own policy is
 * kept as-is, which is also what keeps unrelated failures cheap.
 */
async function handleRetry(ctx: Plugin.Context, input: RetryPayload): Promise<void> {
	const now = Date.now();
	const rawMessage = [input.error.message, input.error.response?.body]
		.filter((part) => typeof part === "string" && part.trim().length > 0)
		.join("\n");
	if (rawMessage.length === 0) return; // Provider text is the classifier's only input; nothing to classify.
	const config = readConfig(ctx, input.sessionID);
	if (config === undefined) return;

	const catalog = (await ctx.model.list()).data;
	const info = findInCatalog(catalog, input.model.providerID, input.model.id);
	const failing: ModelId =
		info !== undefined ? `${info.providerID}/${info.modelID}` : `${input.model.providerID}/${input.model.id}`;
	const chain = config.models.find((model) => model.fallbacks.includes(failing));
	if (chain === undefined) return; // This model answers to no configured chain; OpenCode's policy stands.

	const availability = catalogPort(catalog);
	const jev = chain.jev;
	const registry: RouterRegistryPort = {
		...availability,
		...systemOneClassifierPort({
			baseUrl: jev?.baseUrl,
			...(jev?.apiKey !== undefined ? { apiKey: jev.apiKey } : {}),
			identity: { provider: jev?.provider ?? "", id: jev?.id ?? "" },
		}),
	};
	const assessed = await assessFailure({
		failedId: failing,
		errorMessage: rawMessage,
		stopReason: undefined,
		jev,
		registry,
		now,
		blocked: readBlockedMap(now),
		// Every hook sighting is fresh: OpenCode owns the retry schedule, and a
		// cycle pi counts in-flight is a cycle OpenCode's own policy already
		// counted. Transient state does not cross the host boundary.
		transientRetries: 0,
	});
	if (assessed.noClassifierReason !== undefined) {
		// No verdict, no block, no switch (root AGENTS.md rule 1). Recording the
		// sighting keeps the gap visible in the shared crash corpus.
		recordDecideCrash(
			assessed.failedId,
			registry,
			rawMessage,
			now,
			null,
			assessed.noClassifierReason,
			"blind-cycle",
		);
		notify(
			ctx,
			input.sessionID,
			`switchback: no classifier decision (${assessed.noClassifierReason}) for ${failing}; no block, no switch`,
		);
		return;
	}
	const classified = assessed.verdict;
	if (classified === undefined) return; // Unreachable; satisfies the type without a cast.

	const action: CrashAction = assessed.touchedBlocks ? "blocked+advanced" : "stuck-stayed";
	recordDecideCrash(assessed.failedId, registry, rawMessage, now, classified, undefined, action);
	if (!assessed.touchedBlocks) return; // Transient within OpenCode's own budget: leave its policy standing.

	const resolved = resolveFallbacks(chain.fallbacks, availability);
	const next = pickNextEffective(resolved, failing, readBlockedMap(now), now, failing);
	const until = classified.resetAtMs === undefined ? "" : ` until ${new Date(classified.resetAtMs).toISOString()}`;
	if (next === undefined || next.degraded) {
		// Nothing effective left (or only the failing model itself): surface the
		// failure instead of scheduling another attempt into a blocked model -
		// pi's stuck behavior when the advance finds nothing left.
		notify(
			ctx,
			input.sessionID,
			`switchback: ${failing} blocked${until}; every further fallback in ${chain.id} is unavailable - surfacing the failure`,
		);
		input.decision = { retry: false };
		return;
	}
	const address = splitModelAddress(next.modelId);
	const nextInfo = address === undefined ? undefined : findInCatalog(catalog, address.provider, address.modelId);
	if (nextInfo === undefined) return; // Unreachable: pickNextEffective only offers catalog-backed entries.
	await ctx.session.switchModel({
		sessionID: input.sessionID,
		model: { providerID: nextInfo.providerID, id: nextInfo.modelID },
	});
	notify(
		ctx,
		input.sessionID,
		`switchback: ${classified.class} on ${failing} (blocked${until}) - advancing to ${next.modelId}`,
	);
}

/** Read the shared config once per decision; on a config failure the notice is fan-out-safe. */
function readConfig(ctx: Plugin.Context, sessionID: string): ResolvedSwitchbackFileConfig | undefined {
	try {
		return loadConfig().config;
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
 * effort) so a long-lived session does not spam the conversation. Never
 * blocks: a failed write stays a failed write.
 */
function notify(ctx: Plugin.Context, sessionID: string, message: string): void {
	const seen = seenNotifications.get(sessionID);
	if (seen?.has(message) === true) return;
	seenNotifications.set(sessionID, new Set([...(seen ?? []), message]));
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
	const sections = config.models.map((model) => {
		const resolved = resolveFallbacks(model.fallbacks, availability);
		const rows = resolved.entries.map((entry) => {
			const until = blocked[entry.id];
			const state =
				entry.availability === "effective"
					? until !== undefined
						? `blocked until ${new Date(until).toISOString()}`
						: "available"
					: `unavailable (${entry.reason ?? entry.availability})`;
			return `  - ${entry.id}: ${state}`;
		});
		return `${model.id} (${model.name}): \n${rows.join("\n")}`;
	});
	await ctx.session
		.synthetic({
			sessionID,
			text: `switchback: ${config.models.length} configured chain(s)\n\n${sections.join("\n\n")}`,
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

/** What the adapter reads off a model catalog entry, narrowed to consumed fields. */
interface CatalogModel {
	readonly id: string;
	readonly modelID: string;
	readonly providerID: string;
	readonly name: string;
	readonly enabled: boolean | undefined;
	readonly limit: { readonly context: number } | undefined;
}

/**
 * The availability port over OpenCode's model catalog. The catalog is re-read
 * per decision (one `ctx.model.list()` call) rather than snapshotted: OpenCode
 * edits its own catalog live and the list never lives longer than one
 * classification.
 */
function catalogPort(catalog: readonly CatalogModel[]): AvailabilityPort {
	return {
		find: (provider, modelId) => {
			const info = findInCatalog(catalog, provider, modelId);
			return info === undefined || info.enabled === false ? undefined : hostModel(info);
		},
		hasConfiguredAuth: (model) => findInCatalog(catalog, model.provider, model.id) !== undefined,
		getProviderAuthStatus: (provider) =>
			catalog.some((info) => info.providerID === provider)
				? { configured: true }
				: { configured: false, label: `no enabled models for provider "${provider}" in the OpenCode catalog` },
	};
}

/** A catalog entry gets a second look when it carries OpenCode's own record type. */
function hostModel(info: CatalogModel): HostModel {
	return {
		provider: info.providerID,
		id: info.modelID,
		name: info.name,
		// OpenCode's catalog carries no wire-API name; the core port keeps the
		// field for pi-shaped records and no core switchback step reads it here.
		api: "opencode",
		contextWindow: info.limit?.context ?? 0,
	};
}

/** "provider/id" to its halves; undefined for anything else config could hold. */
function splitModelAddress(serialized: string): { provider: string; modelId: string } | undefined {
	const slash = serialized.indexOf("/");
	if (slash <= 0 || slash === serialized.length - 1) return undefined;
	return { provider: serialized.slice(0, slash), modelId: serialized.slice(slash + 1) };
}

/**
 * Resolve a catalog entry by provider plus model id. OpenCode's catalog
 * entries carry both a bare (`modelID`) and a provider-qualified (`id`)
 * address; switchback's config speaks "provider/modelID", and the openCode
 * surfaces so far (the Model.Ref the retry hook gets) have historically been
 * bare - so both forms resolve.
 */
function findInCatalog(catalog: readonly CatalogModel[], provider: string, modelId: string): CatalogModel | undefined {
	const bare = splitModelAddress(modelId)?.modelId ?? modelId;
	return catalog.find(
		(info) =>
			info.providerID === provider && (info.modelID === modelId || info.modelID === bare || info.id === modelId),
	);
}
