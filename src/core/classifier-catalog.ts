/**
 * The classifier providers the config dialogue offers.
 *
 * Every entry is derived from pi at runtime: the model registry already knows
 * which providers exist, what they are called, where they live and which
 * classifier models each one ships. Switchback keeps **no** provider table of
 * its own - not a provider id, not a display name, not a base URL, not a model
 * id. Anything hardcoded here would drift the moment pi-ai's generated catalog
 * moves, and pi-ai's `dist/providers/data/*.json` is a build artifact, not an
 * extension point.
 *
 * An endpoint pi does not know (a local Ollama server, a self-hosted gateway)
 * is not part of the offer: the wizard's "Other" escape hatch collects the
 * provider id and base URL from the user, and switchback registers that
 * endpoint itself. Once configured it appears in the registry like any other
 * provider, so later edits are prefilled from the config rather than guessed.
 */

/** One classifier model a provider ships, as pi's registry reports it. */
export interface ClassifierModelSummary {
	/** Model id to write into the config. */
	id: string;
	/** Wire API that model speaks (the value for the config's `api` key). */
	api: string;
}

/** One provider as pi's registry reports it, reduced to what the wizard needs. */
export interface ClassifierProviderSource {
	/** Provider id. */
	id: string;
	/** Provider display name. */
	name: string;
	/** Provider base URL, when the provider declares one. */
	baseUrl?: string;
	/** Classifier models this provider ships (empty when it has none). */
	classifiers: readonly ClassifierModelSummary[];
	/** How many chat models pi already has for this provider (clash detection). */
	chatModels: number;
}

/** One choice in the decision-model wizard's provider step. */
export interface ClassifierProviderOption {
	/** Provider id written to the config. */
	provider: string;
	/** Choice label, e.g. "typesafe — TypeSafe". */
	label: string;
	/** Provider display name, without the id prefix the label carries. */
	displayName: string;
	/**
	 * Base URL. Present when the provider declares one; absent means "resolve
	 * from pi's catalog", i.e. the config carries no `baseUrl` key.
	 */
	baseUrl?: string;
	/**
	 * Wire API to write alongside `baseUrl`, taken from the provider's own
	 * classifier models. Absent when the provider declares none.
	 */
	api?: string;
	/** Classifier model ids the provider ships, sorted. */
	models: readonly string[];
	/**
	 * True for an endpoint the user named themselves (the wizard's "Other"
	 * path, or a provider already configured with a direct endpoint). Everything
	 * pi's catalog reports is false: those are resolved, not registered.
	 */
	local: boolean;
	/** How many chat models pi already has for this provider; 0 when unknown. */
	chatModels: number;
}

/**
 * Build the provider choices from pi's registry view: every provider that ships
 * at least one classifier model, alphabetically. A provider with no classifier
 * models is left out rather than offered as a dead end - a direct endpoint is
 * reachable through the wizard's "Other" choice.
 */
export function buildClassifierProviders(source: readonly ClassifierProviderSource[]): ClassifierProviderOption[] {
	const options: ClassifierProviderOption[] = [];
	for (const provider of source) {
		if (provider.classifiers.length === 0) continue;
		const models = provider.classifiers.map((model) => model.id);
		const api = provider.classifiers[0]?.api;
		options.push({
			provider: provider.id,
			label: `${provider.id} — ${provider.name}`,
			displayName: provider.name,
			...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
			...(api !== undefined ? { api } : {}),
			models: [...models].sort(),
			local: false,
			chatModels: provider.chatModels,
		});
	}
	options.sort((a, b) => a.provider.localeCompare(b.provider));
	return options;
}

/**
 * A short note for a choice's screen title: where the prefilled base URL came
 * from, so the value is explainable rather than magic.
 */
export function classifierBaseUrlNote(option: ClassifierProviderOption): string {
	if (option.baseUrl === undefined) return "resolved from pi's model catalog (no baseUrl needed)";
	return `from pi's model catalog: ${option.baseUrl}`;
}

/**
 * Whether writing a direct endpoint (`baseUrl`) for this choice would make pi
 * replace models it already owns.
 *
 * pi's `applyExtension` returns `config.models.map(...)` whenever an extension
 * registers a provider with a model list, so declaring a classifier under a
 * provider that already serves chat models drops those chat models for the
 * session. Derived from the registry rather than a list of "reserved" ids:
 * whatever pi has models for is reserved, by definition.
 */
export function directEndpointWouldClobber(option: ClassifierProviderOption): boolean {
	return option.chatModels > 0;
}

/**
 * Build a suggested decision-model name from the provider + model id. Used as
 * the prefilled default in the last wizard step. Keeps the user's keystrokes
 * to a Tab + Enter for the common case of accepting the suggestion.
 */
export function defaultDecisionModelName(provider: string, modelId: string): string {
	const cleanedModel = modelId.replace(/[:/]/g, "-").replace(/-latest$/u, "");
	return `${provider}-${cleanedModel}`;
}
