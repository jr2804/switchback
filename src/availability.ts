/**
 * Per-route availability resolution.
 *
 * Resolves every entry in the user's configured fallback list against the
 * current pi model registry. Each entry is classified as:
 *   - effective                 - the model is in the catalog AND its provider has working credentials.
 *   - greyed-model-not-in-catalog - the catalog no longer lists this model id.
 *   - greyed-provider-unavailable  - the provider is not credentialed in the current pi session.
 *
 * Resolution is per-call (no caching) so an entry that reappears after the user
 * fixes their setup becomes effective again with no config edit. Greyed entries
 * are NEVER written to the account-scoped block map
 * (`<piConfigDir>/switchback/blocks.json`); they are an availability concern,
 * not a quota concern.
 *
 * The user config is the single source of truth for which entries to consider;
 * we never silently drop entries. Removing a greyed entry from the config is
 * an explicit user action.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type { Availability, BlockedMap, ModelId, ResolvedEntry, ResolvedFallbacks } from "./types.ts";

/** Minimum slice of `pi.modelRegistry` needed for availability resolution. */
export interface AvailabilityRegistry {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
	getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
}

function splitModelId(modelId: ModelId): { provider: string; id: string } | undefined {
	const slash = modelId.indexOf("/");
	if (slash <= 0 || slash === modelId.length - 1) return undefined;
	return { provider: modelId.slice(0, slash), id: modelId.slice(slash + 1) };
}

/**
 * Resolve every configured fallback against the registry. Returns the full list
 * (effective + greyed) plus counts. Pure apart from the registry read.
 */
export function resolveFallbacks(fallbacks: readonly ModelId[], registry: AvailabilityRegistry): ResolvedFallbacks {
	const entries: ResolvedEntry[] = [];
	let effectiveCount = 0;
	let greyedCount = 0;
	for (const modelId of fallbacks) {
		const split = splitModelId(modelId);
		if (split === undefined) {
			entries.push({ id: modelId, availability: "greyed-model-not-in-catalog", reason: "invalid-id-format" });
			greyedCount += 1;
			continue;
		}
		const model = registry.find(split.provider, split.id);
		if (!model) {
			entries.push({ id: modelId, availability: "greyed-model-not-in-catalog", reason: "model-not-in-catalog" });
			greyedCount += 1;
			continue;
		}
		const authStatus = registry.getProviderAuthStatus(split.provider);
		if (!authStatus.configured) {
			entries.push({
				id: modelId,
				availability: "greyed-provider-unavailable",
				reason: authStatus.label ?? "no-credentials",
			});
			greyedCount += 1;
			continue;
		}
		if (!registry.hasConfiguredAuth(model)) {
			entries.push({
				id: modelId,
				availability: "greyed-provider-unavailable",
				reason: "model-not-credentialed",
			});
			greyedCount += 1;
			continue;
		}
		entries.push({ id: modelId, availability: "effective" });
		effectiveCount += 1;
	}
	return { entries, effectiveCount, greyedCount };
}

/** Return the list of effective model ids in their configured order. */
export function effectiveIds(resolved: ResolvedFallbacks): ModelId[] {
	const out: ModelId[] = [];
	for (const entry of resolved.entries) {
		if (entry.availability === "effective") out.push(entry.id);
	}
	return out;
}

/** Return a single greyed entry's reason string, or undefined when not greyed. */
export function greyedReason(entry: ResolvedEntry | undefined): string | undefined {
	if (!entry || entry.availability === "effective") return undefined;
	return entry.reason;
}

/**
 * Pick the next effective, non-blocked entry, skipping `skip`.
 *
 * Degraded mode (returns the most-preferred effective entry even when blocked) is
 * only allowed when there is exactly one effective entry. With multiple effective
 * entries, every-blocked returns undefined so the router surfaces an explicit
 * "exhausted" decision - a failing-provider response is NOT preferable to an
 * explicit "all blocked" signal when there are still options.
 */
export function pickNextEffective(
	resolved: ResolvedFallbacks,
	skip: ModelId | undefined,
	blocked: BlockedMap,
	now: number,
): { modelId: ModelId; degraded: boolean } | undefined {
	const effective = effectiveIds(resolved);
	if (effective.length === 0) return undefined;
	// First pass: skip the failed model AND skip blocked entries, prefer earliest.
	for (const candidate of effective) {
		if (candidate === skip) continue;
		const blockedUntil = blocked[candidate];
		if (blockedUntil !== undefined && blockedUntil > now) continue;
		return { modelId: candidate, degraded: false };
	}
	// Degraded mode: only when exactly one effective entry exists. Edge case #4.
	if (effective.length === 1) {
		return { modelId: effective[0]!, degraded: true };
	}
	// Multiple effective entries all blocked: return undefined so the router
	// surfaces "exhausted" rather than silently degrading.
	return undefined;
}

export type { Availability, ResolvedEntry, ResolvedFallbacks };