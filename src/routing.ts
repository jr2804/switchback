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

import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { pickNextEffective, resolveFallbacks, type AvailabilityRegistry } from "./availability.ts";
import { classifyError, PROMPT_VERSION, type NoClassifierReason } from "./classify.ts";
import { availableCategories, chooseThinkingLevel, type ThinkingLevelContext, type ThinkingLevelSource } from "./thinking.ts";
import { blockModel, unblockModel } from "./state.ts";
import { recordCrash, type CrashAction } from "./crashes.ts";
import type { BlockedMap, ModelId, SwitchbackConfig, SwitchbackState } from "./types.ts";

/** Maximum number of transient retries on the same model before the router moves on. */
export const MAX_TRANSIENT_RETRIES = 1;

/** Decision the router made. Surfaced for tests and the simulate-mode replay log. */
export type Decision =
	| { kind: "stick"; modelId: ModelId; reason: string }
	| { kind: "switch"; modelId: ModelId; reason: string }
	| { kind: "exhausted"; reason: string }
	| { kind: "config-invalid"; reason: string; effective: ModelId[]; greyed: { id: ModelId; reason: string }[] };

/** The subset of the pi modelRegistry that the router needs. */
export type RouterRegistry = ExtensionContext["modelRegistry"];

/** What one `route()` call resolves to. */
export interface DecisionOutcome {
	decision: Decision;
	nextState?: SwitchbackState;
	thinkingLevel: ModelThinkingLevel;
	/**
	 * How `thinkingLevel` was decided, present when the route activated a model.
	 * `classifier` means the SystemOne classifier resolved the user's category
	 * against the activated model; `requested` means it was clamped instead.
	 */
	thinkingSource?: ThinkingLevelSource;
}

/** UI notification sink. Called once per `no-classifier` decision. */
export type NotifyFn = (message: string, type: "info" | "warning" | "error") => void;

export interface RouteInputs {
	now: number;
	blocked: BlockedMap;
	/** Optional simulate-mode error message injected for `retry` requests. */
	simulateErrorMessage?: string;
	/** When provided, the router surfaces no-classifier conditions via this sink. */
	notify?: NotifyFn;
	/** When true, emit one diagnostics line per model switch (see `debug:` in the config). */
	debug?: boolean;
}

function lookupModel(registry: RouterRegistry, modelId: ModelId): Model<Api> | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0) return undefined;
	return registry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
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
	modelConfig: SwitchbackConfig,
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

	// "user" or "direct": the session stays where it is. Stickiness is the fix for the
	// reported behaviour where every turn restarted at the head of the list, so a model
	// that had just failed the session was preferred again. A blocked or unavailable
	// current model is left behind, and the walk continues FORWARD from it.
	const current = request.state?.current;
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
	const pick = pickNextEffective(resolved, undefined, blocked, now, current);
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

async function decideRetry(
	request: ModelRouteRequest<SwitchbackState>,
	modelConfig: SwitchbackConfig,
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
		const pick = pickNextEffective(resolved, undefined, blocked, now, advanceFrom);
		if (!pick) {
			return { decision: { kind: "exhausted", reason: "all-effective-blocked" }, thinkingLevel: request.thinkingLevel };
		}
		return {
			decision: { kind: "switch", modelId: pick.modelId, reason: "no-prior-state" },
			nextState: buildStateAfterSwitch(pick.modelId, undefined),
			thinkingLevel: request.thinkingLevel,
		};
	}

	const result = await classifyError(errorMessage, registry, modelConfig.jev, now, stopReason);

	// No-classifier path: the universal cycle. Report visibly (when notify is
	// wired), advance to the next non-blocked effective model, do NOT write to
	// the account-scoped block map, do NOT call blockModel. The cycle is the one allowed
	// heuristic; no class label is fabricated.
	if (result.kind === "no-classifier") {
		const reasonText = describeNoClassifier(result.reason);
		inputs.notify?.(`switchback: no classifier decision (${result.reason}) - cycling without classification`, "warning");
		const pick = pickNextEffective(resolved, failedId, blocked, now, advanceFrom);
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

	const classified = result.classified;

	// Overflow: pi already compacted; the route stays as the router chose it. Stick
	// to the failed model without blocking or counting as a transient retry.
	if (classified.class === "overflow") {
		const modelId = failedId ?? priorState?.current ?? "(unknown)";
		if (failedId !== undefined) {
			unblockModel(failedId);
		}
		recordDecideCrash(failedId, registry, errorMessage, now, classified, undefined, "stuck-stayed");
		return {
			decision: { kind: "stick", modelId, reason: "overflow-stick" },
			nextState: keepState(failedId ?? priorState?.current ?? modelConfig.fallbacks[0]!, priorState, priorState?.transientRetries ?? 0),
			thinkingLevel: request.thinkingLevel,
		};
	}

	// Transient: stay on the same model up to MAX_TRANSIENT_RETRIES, then move on.
	if (classified.class === "transient") {
		const retries = priorState?.transientRetries ?? 0;
		if (retries < MAX_TRANSIENT_RETRIES && !isBlockedNow(failedId, blocked, now)) {
			recordDecideCrash(failedId, registry, errorMessage, now, classified, undefined, "stuck-stayed");
			return {
				decision: { kind: "stick", modelId: failedId, reason: "transient-retry" },
				nextState: keepState(failedId, priorState, retries + 1),
				thinkingLevel: request.thinkingLevel,
			};
		}
		const pick = pickNextEffective(resolved, failedId, blocked, now, advanceFrom);
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

	// Quota / auth / unknown: block the failed model with the classifier-supplied
	// reset time and pick the next non-blocked.
	blockModel(failedId, classified.resetAtMs, now);
	const pick = pickNextEffective(resolved, failedId, blocked, now, advanceFrom);
	recordDecideCrash(failedId, registry, errorMessage, now, classified, undefined, pick ? "blocked+advanced" : "stuck-stayed");
	if (pick) {
		const nextState = buildStateAfterSwitch(pick.modelId, priorState);
		if (pick.degraded && resolved.effectiveCount === 1 && !nextState.degradedWarned) {
			nextState.degradedWarned = true;
		}
		return {
			decision: { kind: "switch", modelId: pick.modelId, reason: (pick.degraded ? `${classified.class}-fallback-degraded` : `${classified.class}-fallback`) + resetSuffix(classified.resetAtMs, now) },
			nextState,
			thinkingLevel: request.thinkingLevel,
		};
	}
	return { decision: { kind: "exhausted", reason: `${classified.class}-no-fallback` }, thinkingLevel: request.thinkingLevel };
}

/** Human suffix for the reset window a blocked model got, empty when there is none. */
function resetSuffix(resetAtMs: number | undefined, now: number): string {
	if (resetAtMs === undefined) return "";
	return ` (reset in ${Math.max(1, Math.round((resetAtMs - now) / 60_000))} min)`;
}

/**
 * Resolve the dispatched reasoning level for a decision.
 *
 * - A `switch` decision sends the request to a model the session was not on, so the
 *   user's reasoning category is resolved against that concrete model (see
 *   `src/thinking.ts`): switchback's categories are fixed, the models' level maps
 *   are not, and the classifier is the only decision source.
 * - A sticky `user`/`direct` decision stays on the current model, which is when a
 *   manual reasoning change lands. The category passes through untouched when the
 *   staying model supports it (zero cost); when it names a category the model
 *   cannot express, it is resolved by the classifier instead of being clamped
 *   silently at dispatch.
 * - Sticky *internal* routes (continuation, same-model transient retry, overflow)
 *   keep their level in all cases: it is part of the provider's thinking
 *   signature and prompt cache.
 */
async function resolveDispatchLevel(
	outcome: DecisionOutcome,
	request: ModelRouteRequest<SwitchbackState>,
	modelConfig: SwitchbackConfig,
	registry: AvailabilityRegistry & RouterRegistry,
	inputs: RouteInputs,
): Promise<DecisionOutcome> {
	const kind = outcome.decision.kind;
	if (kind !== "switch" && kind !== "stick") return outcome;
	const model = lookupModel(registry, outcome.decision.modelId);
	if (model === undefined) return outcome;
	// A manual change (sticky `user`/`direct`) only needs resolution when the staying
	// model cannot express the requested category at all; every other sticky route is
	// left untouched (the level is part of the thinking signature / prompt cache).
	const isStickyManualChange =
		kind === "stick" && (request.reason === "user" || request.reason === "direct");
	if (!isStickyManualChange && kind === "stick") return outcome;
	const requested = outcome.thinkingLevel;
	const context: ThinkingLevelContext = {
		routeReason: request.reason,
		failover: request.failed !== undefined,
	};

	// A manual change that the staying model can express verbatim: pass it through.
	if (isStickyManualChange && availableCategories(model).includes(requested)) {
		return outcome;
	}
	const choice = await chooseThinkingLevel({
		registry,
		jev: modelConfig.jev,
		model,
		requested,
		context,
	});
	if (inputs.debug === true) {
		// One line per switch or unsupported manual change: what decided the route and
		// how the requested category resolved against the model about to serve it.
		const from = request.state?.current ?? "(new session)";
		const head = isStickyManualChange
			? `stays on ${outcome.decision.modelId}`
			: `switch ${from} → ${outcome.decision.modelId}`;
		const conf = choice.confidence === undefined ? "" : `, confidence ${choice.confidence.toFixed(2)}`;
		const source = choice.source === "classifier" ? `classifier${conf}` : choice.reason === undefined ? "clamp" : `clamp (${choice.reason})`;
		inputs.notify?.(
			`switchback: ${head} [${outcome.decision.reason}] · level ${requested} → ${choice.level} (${source}; model offers: ${availableCategories(model).join(", ")})`,
			"info",
		);
	}
	return { ...outcome, thinkingLevel: choice.level, thinkingSource: choice.source };
}

/**
 * Resolve a `ModelRoute` from a `Decision`.
 *
 * Step 8 fix: this function NEVER throws for "config-invalid" decisions or for
 * decisions on greyed entries. It only throws when the picked effective model
 * was lost between `decide()` and `buildRoute()` (e.g. registry state changed
 * mid-call) - in that case the caller's availability resolution was stale and
 * the caller should retry.
 */
export function buildRoute(
	registry: RouterRegistry,
	decision: Decision,
	thinkingLevel: ModelThinkingLevel,
	nextState: SwitchbackState | undefined,
): ModelRoute<SwitchbackState> {
	if (decision.kind === "config-invalid") {
		throw new ConfigInvalidError(decision);
	}
	if (decision.kind === "exhausted") {
		throw new Error(`switchback: ${decision.reason}`);
	}
	const model = lookupModel(registry, decision.modelId);
	if (!model) throw new Error(`switchback: model "${decision.modelId}" not in catalog (lost between decide() and buildRoute())`);
	// Clamp to the routed model. A virtual level the physical model does not implement
	// (zai has no "medium" and cannot disable thinking at all) is otherwise sent as the
	// provider default, which is what makes "I changed reasoning effort and nothing
	// happened" look like a bug. Pi clamps too; doing it here keeps the returned route
	// honest for every caller.
	const route: ModelRoute<SwitchbackState> = { model, thinkingLevel: clampThinkingLevel(model, thinkingLevel) };
	if (nextState !== undefined) route.state = nextState;
	return route;
}

export class ConfigInvalidError extends Error {
	readonly decision: Extract<Decision, { kind: "config-invalid" }>;
	constructor(decision: Extract<Decision, { kind: "config-invalid" }>) {
		super(`switchback: config invalid (${decision.reason}); effective=[${decision.effective.join(", ")}] greyed=[${decision.greyed.map((g) => `${g.id}:${g.reason}`).join(", ")}]`);
		this.name = "ConfigInvalidError";
		this.decision = decision;
	}
}
