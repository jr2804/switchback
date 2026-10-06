/**
 * Context-window fit for a switch target.
 *
 * When a model fails and the router has to pick another one, the session's
 * context travels with it. pi sizes the conversation against the model the
 * request is routed to (`agent-session.js` checks the compaction threshold with
 * `route.model.contextWindow` for virtual selections), so moving to a model with
 * a smaller window than the current context forces compaction right after the
 * switch - the conversation gets summarized for no reason other than the hop.
 *
 * The rule here is a **preference, never a filter**: among the models that are
 * usable anyway (effective and not blocked), one that can hold the current
 * context is preferred over one that cannot. If nothing can hold it, the normal
 * preference order still wins - keeping the session alive matters more than
 * avoiding a context drop, and compaction is pi's own, correct behaviour in that
 * case. Nothing here ever changes what is *eligible*, and nothing here runs on a
 * sticky route: the preference only orders candidate selection while the router
 * is already looking for a new model.
 *
 * `CONTEXT_FIT_RESERVE_TOKENS` leaves room for the response: pi compacts when
 * the context exceeds `contextWindow - reserve`, so a model that only *just*
 * fits would compact immediately after the switch.
 *
 * Which of the fitting candidates is *best* is a judgement, and that part is the
 * decision model's: when more than one candidate can hold the conversation the
 * classifier is asked to choose among them, with the context size, every
 * candidate's window and headroom, the model that just failed and the
 * deterministic preference order in the state. The deterministic pick stays the
 * floor - an absent, failed or unreadable classifier answer keeps it - so this
 * can only reorder candidates that were already eligible, never introduce one.
 */

import type { Api, ClassifierContext, ClassifierQuestion, Model } from "@earendil-works/pi-ai";
import { callClassifier, readChoice, readConfidence, type ClassifierRegistry, type NoClassifierReason } from "./classify.ts";
import type { JevConfig, ModelId } from "./types.ts";

/**
 * Headroom kept free when judging whether a model can hold the current context.
 * Matches pi's own default compaction reserve; the preference is advisory, so an
 * approximate margin is enough.
 */
export const CONTEXT_FIT_RESERVE_TOKENS = 16_384;

/** The context tokens a model can hold without tripping pi's compaction threshold. */
export function usableContextTokens(model: Model<Api>): number {
	return Math.max(0, (model.contextWindow ?? 0) - CONTEXT_FIT_RESERVE_TOKENS);
}

/** True when `tokens` fits in the model's usable context window. */
export function fitsContext(model: Model<Api>, tokens: number): boolean {
	return tokens <= usableContextTokens(model);
}

/** Prompt version of the candidate-choice question (independent of the others). */
export const CONTEXT_CANDIDATE_PROMPT_VERSION = "v1";

/** One eligible switch target, with the window it offers. */
export interface CandidateWindow {
	id: ModelId;
	contextWindow: number;
	name?: string;
}

export interface ContextCandidateInput {
	registry: ClassifierRegistry;
	jev: JevConfig | undefined;
	/** The deterministic pick: the floor the classifier may only reorder. */
	preferred: ModelId;
	/** Current context size in tokens. */
	contextTokens: number;
	/** Eligible candidates (effective, unblocked, fitting), in preference order. */
	candidates: readonly CandidateWindow[];
	/** Why the router is choosing: `failover` (default) or `idle-reset`. */
	reason?: string;
	/** The model that just failed, when the switch follows a failure. */
	failed?: ModelId;
}

export interface ContextCandidateChoice {
	modelId: ModelId;
	source: "classifier" | "preferred";
	/** Set when the classifier could not decide and the deterministic pick stands. */
	reason?: NoClassifierReason;
	confidence?: number;
}

/** Compact token count for the prompt and the diagnostics ("1M", "128k"). */
function compactTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

/**
 * Let the decision model choose among the candidates that can hold the
 * conversation. Never throws and never returns a model outside `candidates`: a
 * no-classifier outcome, an unreadable answer or an answer that is not one of the
 * offered ids all keep the deterministic pick.
 */
export async function chooseContextCandidate(input: ContextCandidateInput): Promise<ContextCandidateChoice> {
	const ids = input.candidates.map((candidate) => candidate.id);
	if (input.candidates.length <= 1 || !ids.includes(input.preferred)) {
		return { modelId: input.preferred, source: "preferred" };
	}
	const criteria: ClassifierQuestion = {
		type: "choice",
		instructions:
			"A model failed (or the session went idle) and this conversation has to continue on another model. Every option below can hold the current conversation without forcing it to be summarized, so choose the best one. The user's own preference order is given in the state - follow it unless a later option is clearly better for this conversation, for example noticeably more headroom when the context is already large, or avoiding the model that just failed.",
		criteria: Object.fromEntries(
			input.candidates.map((candidate) => [
				candidate.id,
				[
					candidate.name === undefined ? undefined : `${candidate.name}.`,
					`${compactTokens(candidate.contextWindow)} context window,`,
					`${compactTokens(usableContextTokens({ contextWindow: candidate.contextWindow } as Model<Api>))} headroom after the current ${compactTokens(input.contextTokens)} tokens.`,
					candidate.id === input.failed ? "This is the model that just failed." : undefined,
				]
					.filter((part): part is string => part !== undefined)
					.join(" "),
			]),
		),
	};
	const state: ClassifierContext["state"] = {
		route_reason: input.reason ?? "failover",
		failed_model: input.failed ?? "(none)",
		context_tokens: String(input.contextTokens),
		preference_order: ids.join(", "),
		deterministic_pick: input.preferred,
		candidates: input.candidates
			.map((candidate) => `${candidate.id}: ${compactTokens(candidate.contextWindow)} window`)
			.join("; "),
	};
	const call = await callClassifier(input.registry, input.jev, {
		state,
		questions: { candidate: criteria },
	});
	if (call.kind === "no-classifier") {
		return { modelId: input.preferred, source: "preferred", reason: call.reason };
	}
	const answer = readChoice(call.result, "candidate");
	if (answer === undefined || !ids.includes(answer)) {
		return { modelId: input.preferred, source: "preferred", reason: "unparseable" };
	}
	const confidence = readConfidence(call.result, "candidate");
	return {
		modelId: answer,
		source: "classifier",
		...(confidence !== undefined ? { confidence } : {}),
	};
}
