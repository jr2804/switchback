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
 */

import type { Api, Model } from "@earendil-works/pi-ai";

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
