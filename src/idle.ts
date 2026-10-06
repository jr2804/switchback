/**
 * Idle-session reset ("switch to initial").
 *
 * The router is sticky: a session stays on the model it is using, because that
 * preserves the provider's prompt cache and thinking signature. After a long
 * idle period that reasoning stops holding - the cache is gone, so staying costs
 * the same as switching. And because a model with a short quota window and no
 * weekly cap (for example z.ai's 5h window) "respawns" quickly, it can be more
 * efficient to go back to the head of the list and spend that quota first.
 *
 * `idleReset:` is configured per virtual model:
 *
 *     never        stay put, whatever the idle time (default)
 *     30m ... 24h  return to the head of the list once the session has been
 *                  idle at least that long
 *     classifier   ask the decision model whether returning is worthwhile
 *
 * Idle time is measured from the last message in the conversation to now, both
 * of which the route request carries, so no extra bookkeeping or state file is
 * needed. A pin (`/switchback-next`) still outranks this: it is the user's
 * explicit "route here".
 *
 * The classifier mode is asked only once the idle time reaches
 * `IDLE_CLASSIFIER_FLOOR_MS`; below that the answer would be "no" every time and
 * the call would be pure latency on a live session. When the classifier is
 * unavailable (missing / unresolvable / timeout / threw / unparseable) the
 * session simply keeps its current model: unlike error classification, this
 * decision is a preference, so the conservative outcome is to change nothing.
 */

import type { ClassifierContext, ClassifierQuestion, Message } from "@earendil-works/pi-ai";
import { callClassifier, readChoice, readConfidence, type ClassifierRegistry, type NoClassifierReason } from "./classify.ts";
import type { IdleResetConfig, JevConfig, ModelId } from "./types.ts";

/** Every accepted `idleReset:` value, in menu order. */
export const IDLE_RESET_OPTIONS: readonly IdleResetConfig[] = [
	"never",
	"30m",
	"1h",
	"2h",
	"3h",
	"5h",
	"12h",
	"24h",
	"classifier",
];

/** Prompt version of the idle-reset question (independent of the other prompts). */
export const IDLE_RESET_PROMPT_VERSION = "v1";

const MINUTE_MS = 60_000;

/** Fixed thresholds, keyed by the config value. */
const IDLE_RESET_THRESHOLDS_MS: Readonly<Record<string, number>> = {
	"30m": 30 * MINUTE_MS,
	"1h": 60 * MINUTE_MS,
	"2h": 120 * MINUTE_MS,
	"3h": 180 * MINUTE_MS,
	"5h": 300 * MINUTE_MS,
	"12h": 720 * MINUTE_MS,
	"24h": 1_440 * MINUTE_MS,
};

/**
 * Below this idle time the classifier mode is not asked at all. Shorter gaps are
 * a live session, where returning to the head would only throw away a warm cache.
 */
export const IDLE_CLASSIFIER_FLOOR_MS = 30 * MINUTE_MS;

/** True when the option is a fixed duration (not `never` / `classifier`). */
export function isIdleResetDuration(option: IdleResetConfig): boolean {
	return option in IDLE_RESET_THRESHOLDS_MS;
}

/** The fixed threshold in milliseconds, or undefined for `never` / `classifier`. */
export function idleResetThresholdMs(option: IdleResetConfig | undefined): number | undefined {
	if (option === undefined) return undefined;
	return IDLE_RESET_THRESHOLDS_MS[option];
}

/**
 * Timestamp of the newest message in the conversation, or undefined when none
 * carries a usable one. All pi message variants stamp `timestamp`; the scan
 * tolerates a zero/absent stamp on synthetic messages rather than reporting a
 * bogus multi-decade idle time.
 */
export function lastMessageTimestamp(messages: readonly Message[]): number | undefined {
	let latest: number | undefined;
	for (const message of messages) {
		const stamp = message.timestamp;
		if (typeof stamp === "number" && Number.isFinite(stamp) && stamp > 0 && (latest === undefined || stamp > latest)) {
			latest = stamp;
		}
	}
	return latest;
}

/**
 * How long the session has been idle, or undefined when the conversation has no
 * usable timestamp (a fresh session, or a request whose messages carry none).
 */
export function idleMsSince(messages: readonly Message[], now: number): number | undefined {
	const last = lastMessageTimestamp(messages);
	if (last === undefined) return undefined;
	return Math.max(0, now - last);
}

/** Compact human duration for notifications and decision reasons ("6h 12m"). */
export function formatIdle(ms: number): string {
	const totalMinutes = Math.floor(ms / MINUTE_MS);
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** What the idle check concluded. */
export interface IdleResetDecision {
	/** True when the session should leave its sticky model for the head of the list. */
	reset: boolean;
	/** Short human explanation, folded into the decision reason and the debug line. */
	reason: string;
	/** Which mechanism decided: the fixed threshold, the classifier, or neither. */
	source: "threshold" | "classifier" | "none";
	/** The classifier's confidence (classifier-sourced decisions only). */
	confidence?: number;
	/** Set when the classifier mode could not decide. */
	noClassifierReason?: NoClassifierReason;
}

export interface IdleResetInput {
	registry: ClassifierRegistry;
	jev: JevConfig | undefined;
	/** The virtual model's `idleReset:` setting. */
	option: IdleResetConfig | undefined;
	messages: readonly Message[];
	now: number;
	/** The physical model the session is currently on. */
	currentModel: ModelId | undefined;
	/** Effective, non-blocked fallbacks in preference order (the head is the initial model). */
	candidates: readonly ModelId[];
	/** Human notes for the blocked models ("provider/id (resets in 20 min)"). */
	blockedNotes: readonly string[];
}

/**
 * Decide whether a long-idle session should return to the initial model.
 *
 * Never throws: a fixed threshold answers arithmetically, the classifier mode
 * answers through the decision model, and every failure path keeps the session
 * where it is.
 */
export async function decideIdleReset(input: IdleResetInput): Promise<IdleResetDecision> {
	const option = input.option;
	if (option === undefined || option === "never") {
		return { reset: false, reason: "idle-reset off", source: "none" };
	}
	const idle = idleMsSince(input.messages, input.now);
	if (idle === undefined) {
		return { reset: false, reason: "no message timestamp to measure idleness", source: "none" };
	}
	const threshold = idleResetThresholdMs(option);
	if (threshold !== undefined) {
		return idle >= threshold
			? { reset: true, reason: `idle ${formatIdle(idle)} >= ${option}`, source: "threshold" }
			: { reset: false, reason: `idle ${formatIdle(idle)} < ${option}`, source: "none" };
	}
	// classifier mode
	if (idle < IDLE_CLASSIFIER_FLOOR_MS) {
		return {
			reset: false,
			reason: `idle ${formatIdle(idle)} below the ${formatIdle(IDLE_CLASSIFIER_FLOOR_MS)} classifier floor`,
			source: "none",
		};
	}
	return askClassifier(input, idle);
}

/**
 * Ask the decision model whether a long-idle session should go back to the head
 * of the list. The question is deliberately narrow (return vs stay) and carries
 * the facts a judgement needs: how long the gap was, which model the session is
 * on, which model is first in the list, and what the candidates and blocked
 * entries look like right now.
 */
async function askClassifier(input: IdleResetInput, idle: number): Promise<IdleResetDecision> {
	const initial = input.candidates[0];
	const criteria: ClassifierQuestion = {
		type: "choice",
		instructions:
			"The user has left this session idle for a while, so the provider's prompt cache is likely cold and staying on the current model may no longer be cheaper than moving. Decide whether the session should return to the FIRST model in the configured preference list (usually the cheapest quota, for example a short rolling window that resets quickly) or keep using the current model.",
		criteria: {
			return_to_initial:
				"Switch back to the first model in the list. Prefer this when the idle gap is long enough that no cache remains, and the first model is available.",
			keep_current: "Stay on the current model. Prefer this when the idle gap is short enough that the cache may still be warm.",
		},
	};
	const state: ClassifierContext["state"] = {
		idle: formatIdle(idle),
		idle_minutes: String(Math.floor(idle / MINUTE_MS)),
		current_model: input.currentModel ?? "(none - no model activated yet)",
		initial_model: initial ?? "(none - no usable model)",
		preference_order: input.candidates.length > 0 ? input.candidates.join(", ") : "(none)",
		blocked_models: input.blockedNotes.length > 0 ? input.blockedNotes.join(", ") : "(none)",
	};
	const call = await callClassifier(input.registry, input.jev, {
		state,
		questions: { idle_reset: criteria },
	});
	if (call.kind === "no-classifier") {
		return {
			reset: false,
			reason: `idle ${formatIdle(idle)}, no classifier decision (${call.reason}) - staying`,
			source: "none",
			noClassifierReason: call.reason,
		};
	}
	const answer = readChoice(call.result, "idle_reset");
	if (answer !== "return_to_initial" && answer !== "keep_current") {
		return { reset: false, reason: `idle ${formatIdle(idle)}, unreadable answer - staying`, source: "none" };
	}
	if (answer === "keep_current") {
		return { reset: false, reason: `idle ${formatIdle(idle)}, classifier says keep`, source: "classifier" };
	}
	if (initial === undefined) {
		return { reset: false, reason: `idle ${formatIdle(idle)}, no usable initial model`, source: "classifier" };
	}
	const confidence = readConfidence(call.result, "idle_reset");
	return {
		reset: true,
		reason: `idle ${formatIdle(idle)}, classifier says return to ${initial}`,
		source: "classifier",
		...(confidence !== undefined ? { confidence } : {}),
	};
}
