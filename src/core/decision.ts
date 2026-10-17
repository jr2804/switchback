/**
 * The router's decision vocabulary.
 *
 * `src/core/routing.ts` produces these; `src/build-route.ts` and the host
 * adapters consume them. They sit in their own module because they are the one
 * thing both sides must agree on: while they lived in `src/build-route.ts` (a pi
 * module), the core had to import pi to name its own output.
 */

import type { ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ThinkingLevelSource } from "./thinking.ts";
import type { ModelId, SwitchbackState } from "./types.ts";

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
