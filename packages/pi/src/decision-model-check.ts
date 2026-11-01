/**
 * Decision-model existence check.
 *
 * A configured decision model can fail to resolve in ways the config loader
 * cannot see: the core is host-agnostic, so an address like `ollama/tev1` is
 * only checkable against a live model registry. Without a check, a typo (`tev2`
 * for `tev1`), a model deleted from the local Ollama, or a catalog rename
 * surfaced only as silent blind cycling - the router kept routing (that part is
 * the deterministic fallback and is correct), but the user had no way to tell a
 * dead classifier from a working one.
 *
 * This check runs on the first route of a session (the registry is only
 * complete then) and warns once per unresolvable address. It never fails the
 * route: the router's no-classifier path - blind cycling on errors, clamping
 * the reasoning level - remains the deterministic fallback.
 */

import type { ClassifierPort } from "switchback-core/ports.ts";
import type { ResolvedSwitchbackFileConfig } from "switchback-core/types.ts";

/** Split a `provider/id` classifier address; undefined parts mean a malformed one. */
export function splitClassifierAddress(address: string): { provider: string; id: string } | undefined {
	const slash = address.indexOf("/");
	if (slash <= 0 || slash === address.length - 1) return undefined;
	return { provider: address.slice(0, slash), id: address.slice(slash + 1) };
}

/** The decision-model addresses the config references, de-duplicated (`provider/id`). */
export function referencedDecisionModels(config: ResolvedSwitchbackFileConfig): string[] {
	const addresses = new Set<string>();
	for (const model of config.models) {
		if (model.decisionModel !== undefined) addresses.add(`${model.decisionModel.provider}/${model.decisionModel.id}`);
	}
	return [...addresses];
}

/**
 * Check every referenced decision model against the host registry and return
 * one warning per unresolvable address. Pure apart from registry reads; the
 * caller decides how (and how often) to surface the messages.
 */
export function findUnresolvedDecisionModels(
	registry: ClassifierPort,
	config: ResolvedSwitchbackFileConfig,
): string[] {
	const warnings: string[] = [];
	for (const address of referencedDecisionModels(config)) {
		const parts = splitClassifierAddress(address);
		if (parts === undefined) {
			warnings.push(`decision model "${address}" is malformed (expected provider/id) - classifying is disabled`);
			continue;
		}
		const found =
			registry.findOfType("classifier", parts.provider, parts.id) ??
			registry.findOfType("classifier", parts.provider, `${parts.id}:latest`);
		if (found === undefined) {
			warnings.push(
				`decision model "${address}" was not found - switchback falls back to blind cycling and level clamping until it resolves`,
			);
		}
	}
	return warnings;
}
