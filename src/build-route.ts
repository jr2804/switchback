/**
 * Turning a routing decision into the request pi dispatches.
 *
 * `src/routing.ts` decides *where* a request should go; this module decides what
 * that means on the wire. Two steps:
 *
 *  1. `resolveDispatchLevel` settles the reasoning level against the model that
 *     is about to answer - a category is only meaningful relative to a concrete
 *     model's level map, and switchback's categories are fixed while the models'
 *     are not, so the classifier is the only thing that can bridge them.
 *  2. `buildRoute` resolves the chosen id back to a pi `Model`, clamps the
 *     level to what that model actually implements, and attaches the router
 *     state.
 *
 * The split is by responsibility, not by size. The decision types
 * (`Decision`, `DecisionOutcome`) live here because `buildRoute` consumes them
 * and routing.ts produces them - keeping them in `routing.ts` would mean either a
 * circular import or a third module for four type declarations.
 */

import type { ExtensionContext, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { AvailabilityRegistry } from "./availability.ts";
import { availableCategories, chooseThinkingLevel, type ThinkingLevelContext, type ThinkingLevelSource } from "./thinking.ts";
import type { ModelId, ResolvedSwitchbackConfig, SwitchbackState } from "./types.ts";

/** The subset of the pi modelRegistry that the router needs. */
export type RouterRegistry = ExtensionContext["modelRegistry"];

/** Decision the router made. Surfaced for tests and the simulate-mode replay log. */
export type Decision =
	| { kind: "stick"; modelId: ModelId; reason: string }
	| { kind: "switch"; modelId: ModelId; reason: string }
	| { kind: "exhausted"; reason: string }
	| { kind: "config-invalid"; reason: string; effective: ModelId[]; greyed: { id: ModelId; reason: string }[] };

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

/** The parts of `route()`'s inputs that the dispatch step reads. */
export interface DispatchInputs {
	/** When true, emit one diagnostics line per model switch (see `debug:` in the config). */
	debug?: boolean;
	/** When provided, the router surfaces conditions via this sink. */
	notify?: NotifyFn;
}

function lookupModel(registry: RouterRegistry, modelId: ModelId): Model<Api> | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0) return undefined;
	return registry.find(modelId.slice(0, slash), modelId.slice(slash + 1));
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
	registry: AvailabilityRegistry & RouterRegistry,
	inputs: DispatchInputs,
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
 * This function NEVER throws for "config-invalid" decisions or for decisions on
 * greyed entries. It only throws when the picked effective model was lost between
 * `decide()` and `buildRoute()` (e.g. registry state changed mid-call) - in that
 * case the caller's availability resolution was stale and the caller should retry.
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