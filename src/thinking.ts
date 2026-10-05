/**
 * Reasoning-level resolution.
 *
 * switchback exposes one fixed vocabulary of reasoning levels on every virtual
 * model:
 *
 *     off, minimal, medium, high, max
 *
 * Those are the *categories* the user selects from. They are deliberately not
 * the union of what the configured physical models support: a fallback list can
 * mix models with very different thinking-level maps, so a category the user
 * picks may not exist on whichever model the router ends up on. pi clamps such a
 * request at dispatch (every provider API calls `clampThinkingLevel`), which is
 * safe but silent: `medium` and `high` can both become `high`, so moving the
 * selector appears to do nothing.
 *
 * switchback therefore asks the configured SystemOne classifier to resolve the
 * category against the concrete model that was just activated:
 *
 *   - state:    the model, the requested category, our full category list, the
 *               levels that model actually supports, plus route context
 *   - question: one `choice` over the model's supported levels only
 *
 * The answer is used as the dispatched level, so every selection resolves to a
 * level the model really implements. When the classifier is unavailable
 * (missing / unresolvable / timeout / threw / unparseable) the category is
 * simply clamped to the model - the classifier-less baseline, consistent with
 * the router's no-classifier cycle. No keyword or table-driven mapping exists
 * here; the classifier is the only decision source.
 *
 * Resolution happens when a model is activated or switched to. Continuations,
 * retries on the same model, and other sticky routes keep the level they already
 * have, which is what keeps the provider's thinking signature and prompt cache
 * valid.
 */

import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { Api, ClassifierContext, ClassifierQuestion, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { callClassifier, readChoice, readConfidence, type ClassifierRegistry, type NoClassifierReason } from "./classify.ts";

/**
 * The reasoning levels every switchback virtual model offers, independent of
 * which physical models are configured. `minimal` is pi's name for the lowest
 * thinking level above `off`.
 */
export const SWITCHBACK_THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "medium", "high", "max"];

/**
 * Prompt version of the level-recommendation question. Separate from
 * `PROMPT_VERSION` (the locked error-classification prompt) so re-tuning one
 * never invalidates the other.
 */
export const THINKING_PROMPT_VERSION = "v1";

/**
 * What each level means, shown to the classifier as the choice criteria. The
 * keys cover pi's whole level vocabulary so a physical model's own level (for
 * example `low` or `xhigh`, which are outside switchback's categories but inside
 * a model's supported set) still gets a description.
 */
const LEVEL_CRITERIA: Readonly<Record<string, string>> = {
	off: "No extended reasoning; answer in a single pass. Fastest and cheapest.",
	minimal: "One brief reasoning pass; speed over depth.",
	low: "Light reasoning; quick deliberation for routine work.",
	medium: "Moderate reasoning; a balance of depth and latency.",
	high: "Deep reasoning; more deliberation for harder work.",
	xhigh: "Very deep reasoning; noticeably higher latency.",
	max: "Maximum reasoning effort the model offers; slowest and most thorough.",
};

/**
 * The switchback categories a concrete model can actually honour.
 *
 * A category counts only when the model lists it among its supported levels, so
 * a category that would be silently upgraded (or downgraded) is never offered to
 * the classifier as a real option.
 */
export function availableCategories(model: Model<Api>): ModelThinkingLevel[] {
	const supported = new Set(getSupportedThinkingLevels(model));
	return SWITCHBACK_THINKING_LEVELS.filter((level) => supported.has(level));
}

/** Every level a concrete model supports, in pi's extended order. */
export function supportedLevels(model: Model<Api>): ModelThinkingLevel[] {
	return getSupportedThinkingLevels(model);
}

/** Extra, non-level context handed to the classifier with the choice. */
export interface ThinkingLevelContext {
	/** Why the request is being routed (`user` / `continuation` / `retry` / `direct`). */
	routeReason: string;
	/** True when this route follows a failed request, i.e. the router is failing over. */
	failover: boolean;
}

/** How the dispatched level was decided. */
export type ThinkingLevelSource = "classifier" | "requested";

export interface ThinkingLevelChoice {
	level: ModelThinkingLevel;
	source: ThinkingLevelSource;
	/** Set when the classifier could not decide and the category was clamped instead. */
	reason?: NoClassifierReason;
	/** The classifier's confidence in its level answer (classifier-sourced decisions only). */
	confidence?: number;
}

/**
 * Resolve the level to dispatch for a model that was just activated.
 *
 * Never throws and never returns a level the model does not support: an
 * unparseable answer, an answer outside the supported set, or any no-classifier
 * outcome falls back to clamping the requested category.
 */
export async function chooseThinkingLevel(opts: {
	registry: ClassifierRegistry;
	jev: { provider: string; id: string } | undefined;
	model: Model<Api>;
	requested: ModelThinkingLevel;
	context: ThinkingLevelContext;
}): Promise<ThinkingLevelChoice> {
	const fallback = clampThinkingLevel(opts.model, opts.requested);
	const available = availableCategories(opts.model);

	// Nothing to ask: the model cannot honour a category at all, or there is
	// exactly one real option, in which case the classifier has no latitude.
	// `clampThinkingLevel` still guarantees the returned level is dispatchable.
	if (available.length <= 1) {
		return { level: available[0] ?? fallback, source: "requested" };
	}

	const criteria: ClassifierQuestion = {
		type: "choice",
		instructions:
			`Choose the reasoning effort to use for the requested work. The user selected "${opts.requested}" on switchback's category scale (${SWITCHBACK_THINKING_LEVELS.join(", ")}). This model does not implement every category, so choose the supported level that best matches the user's intent and the work described in the state.`,
		criteria: Object.fromEntries(available.map((level) => [level, LEVEL_CRITERIA[level] ?? level])),
	};
	const state: ClassifierContext["state"] = {
		model: `${opts.model.provider}/${opts.model.id}`,
		requested_category: opts.requested,
		model_supported_levels: available.join(", "),
		route_reason: opts.context.routeReason,
		failover: opts.context.failover ? "yes" : "no",
	};

	const call = await callClassifier(opts.registry, opts.jev, {
		state,
		questions: { level: criteria },
	});
	if (call.kind === "no-classifier") {
		return { level: fallback, source: "requested", reason: call.reason };
	}
	const answer = readChoice(call.result, "level");
	if (answer === undefined || !available.includes(answer as ModelThinkingLevel)) {
		// An answer outside the offered set would dispatch a level the model does
		// not implement, so it is treated as unparseable rather than trusted.
		return { level: fallback, source: "requested", reason: "unparseable" };
	}
	const confidence = readConfidence(call.result, "level");
	return { level: answer as ModelThinkingLevel, source: "classifier", ...(confidence !== undefined ? { confidence } : {}) };
}
