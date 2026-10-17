/**
 * Turning a routing decision into the request pi dispatches.
 *
 * `packages/core/src/routing.ts` decides *where* a request should go and
 * `packages/core/src/dispatch.ts` settles the reasoning level; this module expresses that
 * as pi's `ModelRoute`: it resolves the chosen id back to a pi `Model`, clamps the
 * level to what that model actually implements, and attaches the router state.
 *
 * The decision types themselves live in `packages/core/src/decision.ts`: they are the one
 * thing the core and every host adapter must agree on, and a core module cannot
 * import them from a pi module.
 */

import { clampThinkingLevel } from "@earendil-works/pi-ai";
import type { ModelRoute } from "@earendil-works/pi-coding-agent";
import { lookupModel } from "switchback-core/availability.ts";
import type { Decision } from "switchback-core/decision.ts";
import type { ThinkingLevelId } from "switchback-core/ports.ts";
import type { SwitchbackState } from "switchback-core/types.ts";
import type { PiModelLookup } from "./thinking-support.ts";

/**
 * The slice of pi's model registry this module reads: the catalog lookup owned
 * by `./thinking-support.ts`. Narrower than pi's whole registry, but `find` still
 * hands back pi's own `Model`, which is what `ModelRoute` and pi's
 * `clampThinkingLevel` take.
 */
type PiRegistry = PiModelLookup;

/**
 * Resolve a `ModelRoute` from a `Decision`.
 *
 * This function NEVER throws for "config-invalid" decisions or for decisions on
 * greyed entries. It only throws when the picked effective model was lost between
 * `decide()` and `buildRoute()` (e.g. registry state changed mid-call) - in that
 * case the caller's availability resolution was stale and the caller should retry.
 */
export function buildRoute(
	registry: PiRegistry,
	decision: Decision,
	thinkingLevel: ThinkingLevelId,
	nextState: SwitchbackState | undefined,
): ModelRoute<SwitchbackState> {
	if (decision.kind === "config-invalid") {
		throw new ConfigInvalidError(decision);
	}
	if (decision.kind === "exhausted") {
		throw new Error(`switchback: ${decision.reason}`);
	}
	const model = lookupModel(registry, decision.modelId);
	if (!model)
		throw new Error(
			`switchback: model "${decision.modelId}" not in catalog (lost between decide() and buildRoute())`,
		);
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
		super(
			`switchback: config invalid (${decision.reason}); effective=[${decision.effective.join(", ")}] greyed=[${decision.greyed.map((g) => `${g.id}:${g.reason}`).join(", ")}]`,
		);
		this.name = "ConfigInvalidError";
		this.decision = decision;
	}
}
