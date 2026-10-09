/**
 * What a failed request means: the verdict, the block it writes, the crash row
 * it records.
 *
 * `src/routing.ts` decides where a request goes next; this module decides what
 * the failure that just happened *is*. The seam is the two entry points:
 *
 *  - `assessFailure` is called by `decideRetry` in the routing core, which then
 *    turns the verdict into a route.
 *  - `observeUnretriedFailure` is called from the `agent_end` hook for failures pi
 *    decided **not** to retry, where there is no retry left to re-route and the
 *    only useful act is to record the verdict and block the model.
 *
 * Both go through `assessFailure`, so the verdict and the block are produced by
 * exactly the same code whichever path a failure arrives on.
 *
 * Blocking policy: quota / auth / unknown block with the classifier's reset
 * window, transient does not block (it is retried and then moved past), overflow
 * clears any block because pi already compacted. On no-classifier nothing is
 * blocked - there is nothing to justify a block with - and the caller cycles to
 * the next model instead.
 *
 * NOT pure: it writes the account-scoped block map (`blocks.json`) through
 * `state.ts` and appends to the crash store.
 */

import type { StopReason } from "@earendil-works/pi-ai";
import type { AvailabilityRegistry } from "./availability.ts";
import { classifyError, PROMPT_VERSION, type NoClassifierReason } from "./classify.ts";
import type { NotifyFn, RouterRegistry } from "./build-route.ts";
import { recordCrash, type CrashAction } from "./crashes.ts";
import { blockModel, isBlocked, unblockModel } from "./state.ts";
import type { BlockedMap, ClassifiedError, JevConfig, ModelId } from "./types.ts";

/** Maximum number of transient retries on the same model before the router moves on. */
export const MAX_TRANSIENT_RETRIES = 1;

/**
 * Record a crash for one failure. Called once per failure that carries a real
 * error - by `decideRetry` (unless the no-failure-marker early-return fired) and
 * by `observeUnretriedFailure` - so both the classified and the no-classifier
 * paths flow through here and the corpus grows even when no classifier is
 * configured.
 *
 * Errors from the crash store are swallowed: the crash recorder is a side
 * effect, never a blocker on routing.
 */
export function recordDecideCrash(
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
		return {
			failedId,
			errorMessage,
			verdict: undefined,
			noClassifierReason: result.reason,
			transientRetryLeft: false,
			touchedBlocks: false,
		};
	}
	const classified = result.classified;
	if (classified.class === "overflow") {
		if (failedId !== undefined) unblockModel(failedId);
		return {
			failedId,
			errorMessage,
			verdict: classified,
			noClassifierReason: undefined,
			transientRetryLeft: false,
			touchedBlocks: true,
		};
	}
	if (classified.class === "transient") {
		const retries = opts.transientRetries;
		const left = retries < MAX_TRANSIENT_RETRIES && (failedId === undefined || !isBlocked(failedId, now, blocked));
		return {
			failedId,
			errorMessage,
			verdict: classified,
			noClassifierReason: undefined,
			transientRetryLeft: left,
			touchedBlocks: false,
		};
	}
	// Quota / auth / unknown: block with the classifier-supplied reset window.
	if (failedId !== undefined) blockModel(failedId, classified.resetAtMs, now);
	return {
		failedId,
		errorMessage,
		verdict: classified,
		noClassifierReason: undefined,
		transientRetryLeft: false,
		touchedBlocks: true,
	};
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
