/**
 * Which decision models carry their own connection details, and which depend on
 * a host's classifier catalog.
 *
 * This is the one question the config loader deliberately does *not* answer: an
 * address without a `baseUrl` is perfectly valid on a host that has a catalog
 * (pi resolves `typesafe/jev-latest` straight from its model registry), and it
 * is unusable on a host that does not (OpenCode has no catalog, so the address
 * needs `decisionProviders.<provider>` or a `decisionModels.<address>` entry).
 *
 * Both answers are computed here from the resolved config, so the pi check and
 * the OpenCode notice agree on what "has a connection" means and no host repeats
 * the precedence rule (address override wins over the provider entry).
 */

import type { ResolvedSwitchbackFileConfig } from "./types.ts";

/**
 * The minimum shape a connection lookup needs. Both the file config and the
 * resolved config satisfy it, so the dialogue (which re-reads the file) and the
 * host checks (which pass the resolved config) share one rule.
 */
interface ConnectionSource {
	readonly decisionModels?: Readonly<Record<string, { readonly baseUrl?: string }>>;
	readonly decisionProviders?: Readonly<Record<string, { readonly baseUrl?: string }>>;
}

/** Split a `provider/id` decision-model address; undefined parts mean a malformed one. */
export function splitDecisionModelAddress(address: string): { provider: string; id: string } | undefined {
	const slash = address.indexOf("/");
	if (slash <= 0 || slash === address.length - 1) return undefined;
	return { provider: address.slice(0, slash), id: address.slice(slash + 1) };
}

/** The connection details an address resolves to: its own entry first, then its provider's. */
export function decisionModelConnection(config: ConnectionSource, address: string): { baseUrl?: string } | undefined {
	const parts = splitDecisionModelAddress(address);
	return config.decisionModels?.[address] ?? (parts === undefined ? undefined : config.decisionProviders?.[parts.provider]);
}

/** Every decision-model address the config references, de-duplicated, in model order. */
export function referencedDecisionModelAddresses(config: ResolvedSwitchbackFileConfig): string[] {
	const addresses = new Set<string>();
	for (const model of config.models) {
		if (model.decisionModel !== undefined) addresses.add(`${model.decisionModel.provider}/${model.decisionModel.id}`);
	}
	return [...addresses];
}

/**
 * Referenced addresses that carry no `baseUrl` and therefore need a classifier
 * catalog. On pi these resolve from the registry; on OpenCode they are the exact
 * set that silently cannot classify, which is the only case worth a notice.
 */
export function decisionModelsWithoutConnection(config: ResolvedSwitchbackFileConfig): string[] {
	return referencedDecisionModelAddresses(config).filter(
		(address) => decisionModelConnection(config, address)?.baseUrl === undefined,
	);
}
