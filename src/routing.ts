/**
 * Core route() logic: deciding *where* a request goes.
 *
 * `route()` returns a `ModelRoute<SwitchbackState>`. The state is stored on the
 * session branch by pi and replayed on the next request.
 *
 * What a failure *means* - the classification, the block it writes, the crash row
 * it records - lives in `src/failure.ts`; this module asks that module for a
 * verdict and decides where to go next.
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
 *   - reason === "retry"    : assess `request.failed.message` via `src/failure.ts`
 *                             and follow the verdict - quota / auth / unknown ->
 *                             block the failed model with the classifier-supplied
 *                             reset time, then advance; transient -> retry-same up
 *                             to MAX_TRANSIENT_RETRIES; overflow (Jev answer or
 *                             pi's typed `stopReason === "length"`) -> stick
 *                             without blocking; NO-CLASSIFIER (missing /
 *                             unresolvable / timeout / threw / unparseable) ->
 *                             report visibly and cycle to the next effective model
 *                             without writing to the account-scoped block map. That
 *                             cycle is the universal baseline: it fires on every
 *                             failed request when the classifier cannot decide.
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
 * NOT pure: `decide()` reads the account-scoped block map (`blocks.json`) and
 * surfaces no-classifier conditions via `inputs.notify` (the route() callback wires
 * this to `ctx.ui.notify` when `ctx.hasUI`).
 *
 * On unblocking: blocks clear lazily when their reset time passes, or explicitly on
 * the overflow and no-failure-message paths. There is deliberately NO success-unblock
 * path: `route()` has no "request succeeded" event and a blocked model is not routed
 * to (except in single-model degraded mode), so there is no success signal to react
 * to. A model recovers when its block expires.
 */

import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveDispatchLevel, type DecisionOutcome, type NotifyFn, type RouterRegistry } from "./build-route.ts";
import { pickNextEffective, resolveFallbacks, type AvailabilityRegistry } from "./availability.ts";
import type { NoClassifierReason } from "./classify.ts";
import { chooseContextCandidate, fitsContext } from "./context-fit.ts";
import { assessFailure, recordDecideCrash } from "./failure.ts";
import { decideIdleReset } from "./idle.ts";
import { getPinnedModel, isBlocked, unblockModel } from "./state.ts";
import type { BlockedMap, JevConfig, ModelId, ResolvedSwitchbackConfig, SwitchbackState } from "./types.ts";

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
		.filter((entry) => entry.availability === "effective" && !isBlocked(entry.id, opts.now, opts.blocked))
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

/** Human-readable description of a no-classifier reason, for a blind-cycle decision reason. */
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
		if (
			previousId &&
			resolved.entries.some((e) => e.id === previousId && e.availability === "effective") &&
			!isBlocked(previousId, now, blocked)
		) {
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
		if (pin?.availability === "effective" && !isBlocked(pinned, now, blocked)) {
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
			.filter((e) => isBlocked(e.id, now, blocked))
			.map((e) => `${e.id} (resets in ${Math.max(1, Math.round(((blocked[e.id] ?? now) - now) / 60_000))} min)`),
	});
	if (idle.reset) {
		const pick = await pickWithContextFit({
			resolved,
			skip: undefined,
			blocked,
			now,
			startAfter: undefined,
			registry,
			jev: modelConfig.jev,
			reason: "idle-reset",
			contextTokens: inputs.contextTokens,
		});
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
		if (cur?.availability === "effective" && !isBlocked(current, now, blocked)) {
			return {
				decision: { kind: "stick", modelId: current, reason: "session-sticky" },
				nextState: keepState(current, request.state, request.state?.transientRetries ?? 0),
				thinkingLevel: request.thinkingLevel,
			};
		}
	}

	// Nothing usable yet: continue forward from where the session was (wrapping), else
	// start at the head of the configured list.
	const pick = await pickWithContextFit({
		resolved,
		skip: undefined,
		blocked,
		now,
		startAfter: current,
		registry,
		jev: modelConfig.jev,
		contextTokens: inputs.contextTokens,
	});
	if (!pick) {
		// No non-blocked effective entry AND multiple effective entries exist: the user
		// is quota-locked-out across all configured fallbacks. Surface "exhausted" rather
		// than the generic config-invalid (the config is valid, all entries are just blocked).
		return {
			decision: { kind: "exhausted", reason: "all-effective-blocked" },
			thinkingLevel: request.thinkingLevel,
		};
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
		const pick = await pickWithContextFit({
			resolved,
			skip: undefined,
			blocked,
			now,
			startAfter: advanceFrom,
			registry,
			jev: modelConfig.jev,
			contextTokens: inputs.contextTokens,
		});
		if (!pick) {
			return {
				decision: { kind: "exhausted", reason: "all-effective-blocked" },
				thinkingLevel: request.thinkingLevel,
			};
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
	const result =
		assessed.verdict === undefined && assessed.noClassifierReason !== undefined
			? ({ kind: "no-classifier", reason: assessed.noClassifierReason } as const)
			: undefined;
	const classified = assessed.verdict;

	// No-classifier path: the universal cycle. Report visibly (when notify is
	// wired), advance to the next non-blocked effective model, do NOT write to
	// the account-scoped block map, do NOT call blockModel. The cycle is the one allowed
	// heuristic; no class label is fabricated.
	if (result !== undefined) {
		const reasonText = describeNoClassifier(result.reason);
		inputs.notify?.(
			`switchback: no classifier decision (${result.reason}) - cycling without classification`,
			"warning",
		);
		const pick = await pickWithContextFit({
			resolved,
			skip: failedId,
			blocked,
			now,
			startAfter: advanceFrom,
			registry,
			jev: modelConfig.jev,
			contextTokens: inputs.contextTokens,
		});
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
		return {
			decision: { kind: "exhausted", reason: `blind-cycle-${result.reason}-no-fallback` },
			thinkingLevel: request.thinkingLevel,
		};
	}

	// Overflow: pi already compacted; the route stays as the router chose it. Stick
	// to the failed model without blocking or counting as a transient retry.
	if (classified?.class === "overflow") {
		const modelId = failedId ?? priorState?.current ?? "(unknown)";
		recordDecideCrash(failedId, registry, errorMessage, now, classified, undefined, "stuck-stayed");
		return {
			decision: { kind: "stick", modelId, reason: "overflow-stick" },
			nextState: keepState(
				failedId ?? priorState?.current ?? modelConfig.fallbacks[0]!,
				priorState,
				priorState?.transientRetries ?? 0,
			),
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
		const pick = await pickWithContextFit({
			resolved,
			skip: failedId,
			blocked,
			now,
			startAfter: advanceFrom,
			registry,
			jev: modelConfig.jev,
			contextTokens: inputs.contextTokens,
		});
		recordDecideCrash(
			failedId,
			registry,
			errorMessage,
			now,
			classified,
			undefined,
			pick ? "blocked+advanced" : "stuck-stayed",
		);
		if (pick) {
			const nextState = buildStateAfterSwitch(pick.modelId, priorState);
			if (pick.degraded && resolved.effectiveCount === 1 && !nextState.degradedWarned) {
				nextState.degradedWarned = true;
			}
			return {
				decision: {
					kind: "switch",
					modelId: pick.modelId,
					reason: pick.degraded ? "transient-exhausted-degraded" : "transient-exhausted",
				},
				nextState,
				thinkingLevel: request.thinkingLevel,
			};
		}
		return {
			decision: { kind: "exhausted", reason: "transient-exhausted-no-fallback" },
			thinkingLevel: request.thinkingLevel,
		};
	}

	// Quota / auth / unknown: assessFailure has already blocked the failed model
	// with the classifier-supplied reset time; pick the next non-blocked.
	const pick = await pickWithContextFit({
		resolved,
		skip: failedId,
		blocked,
		now,
		startAfter: advanceFrom,
		registry,
		jev: modelConfig.jev,
		contextTokens: inputs.contextTokens,
	});
	recordDecideCrash(
		failedId,
		registry,
		errorMessage,
		now,
		classified ?? null,
		undefined,
		pick ? "blocked+advanced" : "stuck-stayed",
	);
	if (pick) {
		const nextState = buildStateAfterSwitch(pick.modelId, priorState);
		if (pick.degraded && resolved.effectiveCount === 1 && !nextState.degradedWarned) {
			nextState.degradedWarned = true;
		}
		return {
			decision: {
				kind: "switch",
				modelId: pick.modelId,
				reason:
					(pick.degraded ? `${classified!.class}-fallback-degraded` : `${classified!.class}-fallback`) +
					resetSuffix(classified!.resetAtMs, now),
			},
			nextState,
			thinkingLevel: request.thinkingLevel,
		};
	}
	return {
		decision: { kind: "exhausted", reason: `${classified!.class}-no-fallback` },
		thinkingLevel: request.thinkingLevel,
	};
}

/** Human suffix for the reset window a blocked model got, empty when there is none. */
function resetSuffix(resetAtMs: number | undefined, now: number): string {
	if (resetAtMs === undefined) return "";
	return ` (reset in ${Math.max(1, Math.round((resetAtMs - now) / 60_000))} min)`;
}
