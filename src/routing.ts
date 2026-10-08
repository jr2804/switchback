/**
 * Core route() logic.
 *
 * `route()` returns a `ModelRoute<SwitchbackState>`. The state is stored on the
 * session branch by pi and replayed on the next request.
 *
 * Semantics (per design doc, build-order step 5 + step 8, classifier-only
 * architecture from the user's 2026-10-04 directive):
 *
 *   - reason === "user"     : stay on the session's current model. Only when it is
 *                             blocked or no longer available does the walk continue
 *                             forward from its position (or start at the head when the
 *                             branch has no state yet).
 *   - reason === "continuation" : stay on the previous model (keeps prompt cache and
 *                                 thinking signature valid).
 *   - reason === "retry"    : classify `request.failed.message` via the configured
 *                             SystemOne classifier (Jev). Quota / auth / unknown ->
 *                             block the failed model with the classifier-supplied
 *                             reset time, then advance. Transient -> retry-same up
 *                             to MAX_TRANSIENT_RETRIES. Overflow (Jev answer or
 *                             pi's typed `stopReason === "length"`) -> stick without
 *                             blocking. NO-CLASSIFIER (missing / unresolvable /
 *                             timeout / threw / unparseable) -> report visibly and
 *                             cycle to the next effective model without writing to
 *                             the account-scoped block map. The cycle is the universal
 *                             baseline: it fires on every failed request when the
 *                             classifier cannot decide.
 *   - reason === "direct"   : same as "user".
 *
 * Catalog validity (step 8):
 *   - Per-request availability resolution (no caching); greyed-out entries are
 *     skipped but never silently dropped from the user config.
 *   - A single effective model still routes (degraded mode) so a failing provider
 *     response surfaces rather than an opaque router error; one warning per session.
 *   - Zero effective entries = clear config error naming the problem, NOT
 *     "no-non-blocked-fallback".
 *
 * Session stickiness: once the router has moved the session to a model, later turns
 * stay there. Re-picking the head of the list on every user turn is what made a
 * multi-model failover look like it never advanced: a model that had just failed the
 * session was immediately preferred again. A model that is blocked (quota/auth) or no
 * longer in the catalog is left behind, and the walk continues forward from it, so a
 * chain of failures visits the list in order instead of bouncing between the first
 * two entries. A new session starts at the head again.
 *
 * NOT pure: `decide()` reads and writes the blocked-until map (`blocks.json`) via
 * `state.ts` and surfaces no-classifier conditions via `inputs.notify` (the route()
 * callback wires this to `ctx.ui.notify` when `ctx.hasUI`).
 *
 * On unblocking: blocks clear lazily when their reset time passes, or explicitly on
 * the overflow and no-failure-message paths. There is deliberately NO success-unblock
 * path: `route()` has no "request succeeded" event and a blocked model is not routed
 * to (except in single-model degraded mode), so there is no success signal to react
 * to. A model recovers when its block expires.
 */

import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel, StopReason } from "@earendil-works/pi-ai";
import { resolveDispatchLevel, type Decision, type DecisionOutcome, type NotifyFn, type RouterRegistry } from "./build-route.ts";
import { pickNextEffective, resolveFallbacks, type AvailabilityRegistry } from "./availability.ts";
import { classifyError, PROMPT_VERSION, type NoClassifierReason } from "./classify.ts";
import { chooseContextCandidate, fitsContext } from "./context-fit.ts";
import { decideIdleReset } from "./idle.ts";
import { blockModel, getPinnedModel, isBlocked, readBlockedMap, unblockModel } from "./state.ts";
import { recordCrash, type CrashAction } from "./crashes.ts";
import type { BlockedMap, ClassifiedError, JevConfig, ModelId, ResolvedSwitchbackConfig, SwitchbackState } from "./types.ts";

export { ConfigInvalidError, buildRoute, type Decision, type DecisionOutcome, type NotifyFn, type RouterRegistry } from "./build-route.ts";

/** Maximum number of transient retries on the same model before the router moves on. */
export const MAX_TRANSIENT_RETRIES = 1;

export interface RouteInputs {
	now: number;
	blocked: BlockedMap;
	/** Optional simulate-mode error message injected for `retry` requests. */
	simulateErrorMessage?: string;
	/** When provided, the router surfaces no-classifier conditions via this sink. */
	notify?: NotifyFn;
	/** When true, emit one diagnostics line per model switch (see `debug:` in the config). */
	debug?: boolean;
	/**
	 * Current context size in tokens (from `ctx.getContextUsage()`), when pi can
	 * report it. Used only to *prefer* a switch target that can hold the context -
	 * never to make a model ineligible. See `src/context-fit.ts`.
	 */
	contextTokens?: number;
}

function isBlockedNow(modelId: ModelId, blocked: BlockedMap, now: number): boolean {
	const ts = blocked[modelId];
	return ts !== undefined && ts > now;
}

function buildStateAfterSwitch(current: ModelId, prior: SwitchbackState | undefined): SwitchbackState {
	const next: SwitchbackState = {
		current,
		transientRetries: 0,
	};
	if (prior?.degradedWarned === true) next.degradedWarned = true;
	return next;
}

function keepState(current: ModelId, prior: SwitchbackState | undefined, transientRetries: number): SwitchbackState {
	const next: SwitchbackState = { current, transientRetries };
	if (prior?.degradedWarned === true) next.degradedWarned = true;
	return next;
}

function physicalId(model: ModelRouteRequest<SwitchbackState>["model"] | undefined): ModelId | undefined {
	if (!model) return undefined;
	return `${model.provider}/${model.id}`;
}

/**
 * Pick the next usable model, preferring one that can hold the current context.
 *
 * A preference, never a filter (see `src/context-fit.ts`): when the context size
 * is unknown, or nothing can hold it, the ordinary pick is returned unchanged -
 * continuity matters more than a context drop. When candidates can hold the
 * conversation, the deterministic pick is the floor and the decision model may
 * reorder among them (it never sees an ineligible model, and an absent or
 * unreadable answer keeps the floor).
 */
async function pickWithContextFit(opts: {
	resolved: ReturnType<typeof resolveFallbacks>;
	skip: ModelId | undefined;
	blocked: BlockedMap;
	now: number;
	startAfter: ModelId | undefined;
	registry: RouterRegistry;
	jev: JevConfig | undefined;
	contextTokens: number | undefined;
	reason?: string;
}): Promise<ReturnType<typeof pickNextEffective>> {
	const pick = pickNextEffective(opts.resolved, opts.skip, opts.blocked, opts.now, opts.startAfter);
	const tokens = opts.contextTokens;
	if (!pick || tokens === undefined || tokens <= 0) return pick;
	const fitting = opts.resolved.entries
		.filter((entry) => entry.id !== opts.skip)
		.filter((entry) => entry.availability === "effective" && !isBlockedNow(entry.id, opts.blocked, opts.now))
		.map((entry) => ({ id: entry.id, model: modelOf(opts.registry, entry.id) }))
		.filter((entry): entry is { id: ModelId; model: Model<Api> } => entry.model !== undefined)
		.filter((entry) => fitsContext(entry.model, tokens));
	if (fitting.length === 0) {
		// Nothing can hold the context: keep the ordinary pick (continuity over a
		// context drop) rather than failing the switch.
		return pick;
	}
	const preferred = fitting.some((entry) => entry.id === pick.modelId) ? pick.modelId : fitting[0]!.id;
	if (fitting.length === 1) return { modelId: preferred, degraded: false };
	const choice = await chooseContextCandidate({
		registry: opts.registry,
		jev: opts.jev,
		preferred,
		contextTokens: tokens,
		candidates: fitting.map((entry) => ({
			id: entry.id,
			contextWindow: entry.model.contextWindow ?? 0,
			...(entry.model.name !== undefined ? { name: entry.model.name } : {}),
		})),
		...(opts.reason !== undefined ? { reason: opts.reason } : {}),
		...(opts.skip !== undefined ? { failed: opts.skip } : {}),
	});
	return { modelId: choice.modelId, degraded: false };
}

/** The named physical model, when the registry knows it. */
function modelOf(registry: RouterRegistry, modelId: ModelId): Model<Api> | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0) return undefined;
	return registry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
}

/** Whether the named physical model can hold `tokens` of context (false when unknown). */
function fitsModel(registry: RouterRegistry, modelId: ModelId, tokens: number): boolean {
	const model = modelOf(registry, modelId);
	return model === undefined ? false : fitsContext(model, tokens);
}

/**
 * Record a crash for the current retry. Called once per decideRetry invocation
 * that carries a real failure (i.e. the no-failure-marker early-return did not
 * fire). Both the classified and no-classifier paths flow through here so the
 * corpus grows even when no classifier is configured.
 *
 * Errors from the crash store are swallowed: the crash recorder is a side
 * effect, never a blocker on routing.
 */
function recordDecideCrash(
	failedId: ModelId | undefined,
	registry: AvailabilityRegistry & RouterRegistry,
	errorMessage: string,
	now: number,
	verdict: import("./types.ts").ClassifiedError | null,
	noClassifierReason: NoClassifierReason | undefined,
	action: CrashAction,
): void {
	if (failedId === undefined) return;
	const [provider, model] = failedId.split("/");
	if (!provider || !model) return;
	try {
		recordCrash({
			raw: errorMessage,
			provider,
			model,
			now,
			action,
			verdict,
			...(noClassifierReason ? { noClassifierReason } : {}),
			promptVersion: PROMPT_VERSION,
		});
	} catch {
		// Crash store errors must not affect routing. Swallow.
	}
	// Touch registry to keep the linter from flagging the unused param when
	// the recorded verdict is a structured-signal one with no classifier call.
	void registry;
}

/**
 * Human-readable description of a no-classifier reason. Used in the visible
 * notification, in the decision reason, and in `/switchback` status output.
 */
function describeNoClassifier(reason: NoClassifierReason): string {
	switch (reason) {
		case "not-configured":
			return "no classifier configured (set jev: in switchback.yaml)";
		case "unresolvable":
			return "configured classifier not found in registry";
		case "timeout":
			return "classifier call timed out";
		case "threw":
			return "classifier call threw";
		case "unparseable":
			return "classifier returned an unparseable result";
	}
}

/**
 * Decide what to do for one `route()` call.
 *
 * Side effects: this function may read or write the account-scoped block map
 * (`<piConfigDir>/switchback/blocks.json`) via the imported `blockModel` /
 * `unblockModel`, and surfaces no-classifier
 * conditions via `inputs.notify` (the route() callback wires this to
 * `ctx.ui.notify` when `ctx.hasUI`). It is not pure.
 */
export async function decide(
	reason: ModelRouteRequest<SwitchbackState>["reason"],
	request: ModelRouteRequest<SwitchbackState>,
	modelConfig: ResolvedSwitchbackConfig,
	registry: AvailabilityRegistry & RouterRegistry,
	inputs: RouteInputs,
): Promise<DecisionOutcome> {
	const now = inputs.now;
	const blocked = inputs.blocked;

	// Step 8: resolve availability per call (no caching).
	const resolved = resolveFallbacks(modelConfig.fallbacks, registry);

	// Edge case 5: zero effective entries -> clear config error.
	if (resolved.effectiveCount === 0) {
		const greyed = resolved.entries
			.filter((e) => e.availability !== "effective")
			.map((e) => ({ id: e.id, reason: e.reason ?? e.availability }));
		return {
			decision: {
				kind: "config-invalid",
				reason: "all-configured-fallbacks-greyed",
				effective: [],
				greyed,
			},
			thinkingLevel: request.thinkingLevel,
		};
	}

	if (reason === "continuation") {
		const previousId = physicalId(request.previous?.model);
		if (previousId && resolved.entries.some((e) => e.id === previousId && e.availability === "effective") && !isBlockedNow(previousId, blocked, now)) {
			return {
				decision: { kind: "stick", modelId: previousId, reason: "continuation" },
				thinkingLevel: request.previous?.thinkingLevel ?? request.thinkingLevel,
			};
		}
	}

	if (reason === "retry") {
		const retry = await decideRetry(request, modelConfig, registry, resolved, inputs);
		return resolveDispatchLevel(retry, request, modelConfig, registry, inputs);
	}

	// "user" or "direct": a manual pin (`/switchback-next`) wins first - it is the
	// user's explicit "route here" override, above both stickiness and preference,
	// for as long as the pinned model is usable.
	const pinned = getPinnedModel(modelConfig.id);
	if (pinned !== undefined) {
		const pin = resolved.entries.find((e) => e.id === pinned);
		if (pin?.availability === "effective" && !isBlockedNow(pinned, blocked, now)) {
			return resolveDispatchLevel(
				{
					decision:
						request.state?.current === pinned
							? { kind: "stick", modelId: pinned, reason: "pinned" }
							: { kind: "switch", modelId: pinned, reason: "pinned" },
					nextState: buildStateAfterSwitch(pinned, request.state),
					thinkingLevel: request.thinkingLevel,
				},
				request,
				modelConfig,
				registry,
				inputs,
			);
		}
		// A pin on an unusable model is ignored (blocked or greyed); the normal rules
		// apply and the status command shows why the pin is not being honoured.
	}

	const current = request.state?.current;

	// Idle reset ("switch to initial"): after a long idle the provider's prompt cache
	// is cold, so staying buys nothing, and a model with a short quota window and no
	// weekly cap is worth preferring again. Configured per virtual model; the pin
	// above still outranks it (it is the user's explicit override).
	const idle = await decideIdleReset({
		registry,
		jev: modelConfig.jev,
		option: modelConfig.idleReset,
		messages: request.messages,
		now,
		currentModel: current,
		candidates: resolved.entries.filter((e) => e.availability === "effective").map((e) => e.id),
		blockedNotes: resolved.entries
			.filter((e) => isBlockedNow(e.id, blocked, now))
			.map((e) => `${e.id} (resets in ${Math.max(1, Math.round(((blocked[e.id] ?? now) - now) / 60_000))} min)`),
	});
	if (idle.reset) {
		const pick = await pickWithContextFit({ resolved, skip: undefined, blocked, now, startAfter: undefined, registry, jev: modelConfig.jev, reason: "idle-reset", contextTokens: inputs.contextTokens });
		if (pick) {
			const nextState = buildStateAfterSwitch(pick.modelId, request.state);
			if (pick.degraded && resolved.effectiveCount === 1 && !nextState.degradedWarned) {
				nextState.degradedWarned = true;
			}
			return resolveDispatchLevel(
				{
					decision: {
						kind: current === pick.modelId ? "stick" : "switch",
						modelId: pick.modelId,
						reason: `idle-reset-${idle.source}: ${idle.reason}`,
					},
					nextState,
					thinkingLevel: request.thinkingLevel,
				},
				request,
				modelConfig,
				registry,
				inputs,
			);
		}
	}

	// Stickiness: the session stays where it is. Stickiness is the fix for the
	// reported behaviour where every turn restarted at the head of the list, so a model
	// that had just failed the session was preferred again. A blocked or unavailable
	// current model is left behind, and the walk continues FORWARD from it.
	if (current !== undefined) {
		const cur = resolved.entries.find((e) => e.id === current);
		if (cur?.availability === "effective" && !isBlockedNow(current, blocked, now)) {
			return {
				decision: { kind: "stick", modelId: current, reason: "session-sticky" },
				nextState: keepState(current, request.state, request.state?.transientRetries ?? 0),
				thinkingLevel: request.thinkingLevel,
			};
		}
	}

	// Nothing usable yet: continue forward from where the session was (wrapping), else
	// start at the head of the configured list.
	const pick = await pickWithContextFit({ resolved, skip: undefined, blocked, now, startAfter: current, registry, jev: modelConfig.jev, contextTokens: inputs.contextTokens });
	if (!pick) {
		// No non-blocked effective entry AND multiple effective entries exist: the user
		// is quota-locked-out across all configured fallbacks. Surface "exhausted" rather
		// than the generic config-invalid (the config is valid, all entries are just blocked).
		return { decision: { kind: "exhausted", reason: "all-effective-blocked" }, thinkingLevel: request.thinkingLevel };
	}
	const stateCurrent = request.state?.current;
	const nextState = buildStateAfterSwitch(pick.modelId, request.state);
	// Surface the degraded warning once per session when we're forced onto a blocked
	// model because it is the only effective entry.
	if (pick.degraded && resolved.effectiveCount === 1 && !nextState.degradedWarned) {
		nextState.degradedWarned = true;
	}
	return resolveDispatchLevel(
		{
			decision: {
				kind: stateCurrent === pick.modelId ? "stick" : "switch",
				modelId: pick.modelId,
				reason: pick.degraded ? `degraded-${reason}` : reason,
			},
			nextState,
			thinkingLevel: request.thinkingLevel,
		},
		request,
		modelConfig,
		registry,
		inputs,
	);
}

/** What a failed request turned into, once classified. */
export interface AssessedFailure {
	/** Provider-qualified id of the model that failed, when it could be identified. */
	failedId: string | undefined;
	/** The raw error text the verdict came from. */
	errorMessage: string;
	/** The classifier's verdict, or undefined on the no-classifier path. */
	verdict: ClassifiedError | undefined;
	/** Why there is no verdict, when the classifier could not produce one. */
	noClassifierReason: NoClassifierReason | undefined;
	/** Transient only: a same-model retry is still within budget. */
	transientRetryLeft: boolean;
	/** Whether this assessment wrote a block (or cleared one) for the model. */
	touchedBlocks: boolean;
}

/**
 * Turn one failed request into a verdict and a block, without deciding where to
 * go next.
 *
 * This is the single place a failure becomes a classification and mutates the
 * account-scoped block map, so both callers stay in step:
 *
 *  - `decideRetry` calls it and then routes: pi's own retry is re-routed to a
 *    different model instead of being spent on the one that just failed.
 *  - The `agent_end` hook calls it for failures pi decided **not** to retry
 *    (pi's `isRetryableAssistantError` string-matches the message; a quota error
 *    whose text merely mentions `billing`, for instance, is treated as a
 *    non-retryable limit and never reaches the router). There is no retry left
 *    to re-route, so the only useful act is to record the verdict and block the
 *    model - which is enough, because the next routing decision leaves a blocked
 *    current model behind and walks forward.
 *
 * Blocking policy, unchanged from the retry path: quota / auth / unknown block
 * with the classifier's reset window, transient does not block (it is retried
 * and then moved past), overflow clears any block because pi already compacted.
 */
export async function assessFailure(opts: {
	failedId: string | undefined;
	errorMessage: string;
	stopReason: StopReason | undefined;
	jev: JevConfig | undefined;
	registry: RouterRegistry;
	now: number;
	blocked: BlockedMap;
	transientRetries: number;
}): Promise<AssessedFailure> {
	const { failedId, errorMessage, stopReason, jev, registry, now, blocked } = opts;
	const result = await classifyError(errorMessage, registry, jev, now, stopReason);
	if (result.kind === "no-classifier") {
		// The universal cycle: advance, but never fabricate a class and never write a
		// block - there is nothing to justify one with.
		return { failedId, errorMessage, verdict: undefined, noClassifierReason: result.reason, transientRetryLeft: false, touchedBlocks: false };
	}
	const classified = result.classified;
	if (classified.class === "overflow") {
		if (failedId !== undefined) unblockModel(failedId);
		return { failedId, errorMessage, verdict: classified, noClassifierReason: undefined, transientRetryLeft: false, touchedBlocks: true };
	}
	if (classified.class === "transient") {
		const retries = opts.transientRetries;
		const left = retries < MAX_TRANSIENT_RETRIES && (failedId === undefined || !isBlockedNow(failedId, blocked, now));
		return { failedId, errorMessage, verdict: classified, noClassifierReason: undefined, transientRetryLeft: left, touchedBlocks: false };
	}
	// Quota / auth / unknown: block with the classifier-supplied reset window.
	if (failedId !== undefined) blockModel(failedId, classified.resetAtMs, now);
	return { failedId, errorMessage, verdict: classified, noClassifierReason: undefined, transientRetryLeft: false, touchedBlocks: true };
}

/**
 * Assess a failure pi declined to retry.
 *
 * pi only hands a router an error when `isRetryableAssistantError` accepts its
 * text - a string match against two fixed lists. A provider-limit error that
 * trips the non-retryable list (or neither list) never reaches `route()`, so
 * switchback sees no `failed` at all: the model stays unblocked and the next
 * turn walks straight back into it.
 *
 * This is the fallback for that case. It reuses `assessFailure`, so the
 * verdict and the block are produced by exactly the same code as the retry
 * path; only the routing decision is absent, because there is no retry left to
 * re-route. Returns true when it acted, so the caller can skip duplicates.
 */
export async function observeUnretriedFailure(opts: {
	failedId: string | undefined;
	errorMessage: string;
	stopReason: StopReason | undefined;
	jev: JevConfig | undefined;
	registry: AvailabilityRegistry & RouterRegistry;
	now: number;
	blocked: BlockedMap;
	notify?: NotifyFn;
}): Promise<boolean> {
	const { failedId, errorMessage, now } = opts;
	const assessed = await assessFailure({
		failedId,
		errorMessage,
		stopReason: opts.stopReason,
		jev: opts.jev,
		registry: opts.registry,
		now,
		blocked: opts.blocked,
		transientRetries: 0,
	});
	if (assessed.noClassifierReason !== undefined) {
		opts.notify?.(
			`switchback: ${failedId ?? "the active model"} failed with no classifier decision (${assessed.noClassifierReason}) - not retrying`,
			"warning",
		);
		// No verdict means nothing to justify a block with; record the sighting so
		// the corpus shows the gap, and leave routing untouched.
		recordDecideCrash(failedId, opts.registry, errorMessage, now, null, assessed.noClassifierReason, "blind-cycle");
		return false;
	}
	const classified = assessed.verdict;
	const action: CrashAction = assessed.touchedBlocks ? "blocked+advanced" : "stuck-stayed";
	recordDecideCrash(failedId, opts.registry, errorMessage, now, classified ?? null, undefined, action);
	if (classified !== undefined && assessed.touchedBlocks) {
		opts.notify?.(
			`switchback: ${failedId} failed (${classified.class}, pi will not retry) - blocked${
				classified.resetAtMs === undefined ? "" : ` until ${new Date(classified.resetAtMs).toISOString()}`
			}`,
			"warning",
		);
	}
	return assessed.touchedBlocks;
}

async function decideRetry(
	request: ModelRouteRequest<SwitchbackState>,
	modelConfig: ResolvedSwitchbackConfig,
	registry: AvailabilityRegistry & RouterRegistry,
	resolved: ReturnType<typeof resolveFallbacks>,
	inputs: RouteInputs,
): Promise<DecisionOutcome> {
	const failedId = physicalId(request.failed?.model);
	const errorMessage = inputs.simulateErrorMessage ?? request.failed?.message.errorMessage ?? "";
	const stopReason = request.failed?.message.stopReason;
	const now = inputs.now;
	const blocked = inputs.blocked;
	const priorState = request.state;
	// Continue the walk from the model that failed (falling back to the session's
	// current model), so consecutive failures advance through the list in order rather
	// than bouncing between the first two entries.
	const advanceFrom = failedId ?? priorState?.current;

	// No-failure marker: route only enters here when `failed` is set, but an empty
	// error message AND no stopReason means pi flagged this as a retry without a real
	// failure (rare; treat as a stick and unblock).
	if (failedId === undefined || (errorMessage.trim().length === 0 && stopReason === undefined)) {
		if (priorState) {
			unblockModel(priorState.current);
			return {
				decision: { kind: "stick", modelId: priorState.current, reason: "no-failure-message" },
				thinkingLevel: request.thinkingLevel,
			};
		}
		const pick = await pickWithContextFit({ resolved, skip: undefined, blocked, now, startAfter: advanceFrom, registry, jev: modelConfig.jev, contextTokens: inputs.contextTokens });
		if (!pick) {
			return { decision: { kind: "exhausted", reason: "all-effective-blocked" }, thinkingLevel: request.thinkingLevel };
		}
		return {
			decision: { kind: "switch", modelId: pick.modelId, reason: "no-prior-state" },
			nextState: buildStateAfterSwitch(pick.modelId, undefined),
			thinkingLevel: request.thinkingLevel,
		};
	}

	const assessed = await assessFailure({
		failedId,
		errorMessage,
		stopReason,
		jev: modelConfig.jev,
		registry,
		now,
		blocked,
		transientRetries: priorState?.transientRetries ?? 0,
	});
	const result = assessed.verdict === undefined && assessed.noClassifierReason !== undefined
		? ({ kind: "no-classifier", reason: assessed.noClassifierReason } as const)
		: undefined;
	const classified = assessed.verdict;

	// No-classifier path: the universal cycle. Report visibly (when notify is
	// wired), advance to the next non-blocked effective model, do NOT write to
	// the account-scoped block map, do NOT call blockModel. The cycle is the one allowed
	// heuristic; no class label is fabricated.
	if (result !== undefined) {
		const reasonText = describeNoClassifier(result.reason);
		inputs.notify?.(`switchback: no classifier decision (${result.reason}) - cycling without classification`, "warning");
		const pick = await pickWithContextFit({ resolved, skip: failedId, blocked, now, startAfter: advanceFrom, registry, jev: modelConfig.jev, contextTokens: inputs.contextTokens });
		recordDecideCrash(failedId, registry, errorMessage, now, null, result.reason, "blind-cycle");
		if (pick) {
			const nextState = buildStateAfterSwitch(pick.modelId, priorState);
			if (pick.degraded && resolved.effectiveCount === 1 && !nextState.degradedWarned) {
				nextState.degradedWarned = true;
			}
			return {
				decision: {
					kind: "switch",
					modelId: pick.modelId,
					reason: `blind-cycle-${result.reason}: ${reasonText}`,
				},
				nextState,
				thinkingLevel: request.thinkingLevel,
			};
		}
		return { decision: { kind: "exhausted", reason: `blind-cycle-${result.reason}-no-fallback` }, thinkingLevel: request.thinkingLevel };
	}

	// Overflow: pi already compacted; the route stays as the router chose it. Stick
	// to the failed model without blocking or counting as a transient retry.
	if (classified?.class === "overflow") {
		const modelId = failedId ?? priorState?.current ?? "(unknown)";
		recordDecideCrash(failedId, registry, errorMessage, now, classified, undefined, "stuck-stayed");
		return {
			decision: { kind: "stick", modelId, reason: "overflow-stick" },
			nextState: keepState(failedId ?? priorState?.current ?? modelConfig.fallbacks[0]!, priorState, priorState?.transientRetries ?? 0),
			thinkingLevel: request.thinkingLevel,
		};
	}

	// Transient: stay on the same model up to MAX_TRANSIENT_RETRIES, then move on.
	if (classified?.class === "transient") {
		if (assessed.transientRetryLeft) {
			recordDecideCrash(failedId, registry, errorMessage, now, classified, undefined, "stuck-stayed");
			return {
				decision: { kind: "stick", modelId: failedId!, reason: "transient-retry" },
				nextState: keepState(failedId, priorState, (priorState?.transientRetries ?? 0) + 1),
				thinkingLevel: request.thinkingLevel,
			};
		}
		const pick = await pickWithContextFit({ resolved, skip: failedId, blocked, now, startAfter: advanceFrom, registry, jev: modelConfig.jev, contextTokens: inputs.contextTokens });
		recordDecideCrash(failedId, registry, errorMessage, now, classified, undefined, pick ? "blocked+advanced" : "stuck-stayed");
		if (pick) {
			const nextState = buildStateAfterSwitch(pick.modelId, priorState);
			if (pick.degraded && resolved.effectiveCount === 1 && !nextState.degradedWarned) {
				nextState.degradedWarned = true;
			}
			return {
				decision: { kind: "switch", modelId: pick.modelId, reason: pick.degraded ? "transient-exhausted-degraded" : "transient-exhausted" },
				nextState,
				thinkingLevel: request.thinkingLevel,
			};
		}
		return { decision: { kind: "exhausted", reason: "transient-exhausted-no-fallback" }, thinkingLevel: request.thinkingLevel };
	}

	// Quota / auth / unknown: assessFailure has already blocked the failed model
	// with the classifier-supplied reset time; pick the next non-blocked.
	const pick = await pickWithContextFit({ resolved, skip: failedId, blocked, now, startAfter: advanceFrom, registry, jev: modelConfig.jev, contextTokens: inputs.contextTokens });
	recordDecideCrash(failedId, registry, errorMessage, now, classified ?? null, undefined, pick ? "blocked+advanced" : "stuck-stayed");
	if (pick) {
		const nextState = buildStateAfterSwitch(pick.modelId, priorState);
		if (pick.degraded && resolved.effectiveCount === 1 && !nextState.degradedWarned) {
			nextState.degradedWarned = true;
		}
		return {
			decision: { kind: "switch", modelId: pick.modelId, reason: (pick.degraded ? `${classified!.class}-fallback-degraded` : `${classified!.class}-fallback`) + resetSuffix(classified!.resetAtMs, now) },
			nextState,
			thinkingLevel: request.thinkingLevel,
		};
	}
	return { decision: { kind: "exhausted", reason: `${classified!.class}-no-fallback` }, thinkingLevel: request.thinkingLevel };
}

/** Human suffix for the reset window a blocked model got, empty when there is none. */
function resetSuffix(resetAtMs: number | undefined, now: number): string {
	if (resetAtMs === undefined) return "";
	return ` (reset in ${Math.max(1, Math.round((resetAtMs - now) / 60_000))} min)`;
}
