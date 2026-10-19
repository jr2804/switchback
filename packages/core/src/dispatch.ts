/**
 * Settling the reasoning level a decision dispatches with.
 *
 * A category is only meaningful relative to a concrete model's level map, and
 * switchback's categories are fixed while the models' are not, so the classifier
 * is the only thing that can bridge them. This is the core half of that step; the
 * pi half (building the actual `ModelRoute`) is `packages/pi/src/build-route.ts`.
 */

import type { ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { lookupModel } from "./availability.ts";
import type { DecisionOutcome } from "./decision.ts";
import type { NotifyPort, RouterRegistryPort, ThinkingSupportPort } from "./ports.ts";
import { availableCategories, chooseThinkingLevel, type ThinkingLevelContext } from "./thinking.ts";
import type { ResolvedSwitchbackConfig, SwitchbackState } from "./types.ts";

/** The parts of `route()`'s inputs that the dispatch step reads. */
export interface DispatchInputs {
	/** The host's reasoning-level rules (pi passes pi-ai's; OpenCode derives its own). */
	support: ThinkingSupportPort;
	/** When true, emit one diagnostics line per model switch (see `debug:` in the config). */
	debug?: boolean;
	/** When provided, the router surfaces conditions via this sink. */
	notify?: NotifyPort;
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
export async function resolveDispatchLevel(
	outcome: DecisionOutcome,
	request: ModelRouteRequest<SwitchbackState>,
	modelConfig: ResolvedSwitchbackConfig,
	registry: RouterRegistryPort,
	inputs: DispatchInputs,
): Promise<DecisionOutcome> {
	const kind = outcome.decision.kind;
	if (kind !== "switch" && kind !== "stick") return outcome;
	const model = lookupModel(registry, outcome.decision.modelId);
	if (model === undefined) return outcome;
	// A manual change (sticky `user`/`direct`) only needs resolution when the staying
	// model cannot express the requested category at all; every other sticky route is
	// left untouched (the level is part of the thinking signature / prompt cache).
	const isStickyManualChange = kind === "stick" && (request.reason === "user" || request.reason === "direct");
	if (!isStickyManualChange && kind === "stick") return outcome;
	const requested = outcome.thinkingLevel;
	const context: ThinkingLevelContext = {
		routeReason: request.reason,
		failover: request.failed !== undefined,
	};

	// A manual change that the staying model can express verbatim: pass it through.
	if (isStickyManualChange && availableCategories(model, inputs.support).includes(requested)) {
		return outcome;
	}
	const choice = await chooseThinkingLevel({
		registry,
		support: inputs.support,
		decisionModel: modelConfig.decisionModel,
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
		const source =
			choice.source === "classifier"
				? `classifier${conf}`
				: choice.reason === undefined
					? "clamp"
					: `clamp (${choice.reason})`;
		inputs.notify?.(
			`switchback: ${head} [${outcome.decision.reason}] · level ${requested} → ${choice.level} (${source}; model offers: ${availableCategories(model, inputs.support).join(", ")})`,
			"info",
		);
	}
	return { ...outcome, thinkingLevel: choice.level, thinkingSource: choice.source };
}
