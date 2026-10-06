/**
 * Dedicated local classifier endpoint.
 *
 * pi can only classify through a classifier model that some provider
 * registered. Ollama v0.35+ serves System One models at `POST /v1/systemone`,
 * which speaks the same wire protocol as pi's `typesafe-system-one` transport,
 * but pi ships no Ollama classifier provider and `models.json` cannot express
 * one (its schema has no classifier model type). So switchback declares the
 * endpoint itself, from its own config.
 *
 * `jev.baseUrl` in `switchback.yaml` is the switch. When present, switchback
 * registers `jev.provider` with the classifier model(s) for that endpoint and
 * its own System One transport (src/systemone.ts), so the normal
 * `ctx.modelRegistry.classify()` path - block map, Tier 2b annotation cache,
 * reset scoring - works unchanged.
 *
 * **One endpoint, many models.** `registerProvider` takes the provider's whole
 * model list, and pi replaces that list wholesale when an extension supplies
 * one (`applyExtension` returns `config.models.map(...)`), so the registration
 * has to carry every classifier model that lives on the endpoint in a single
 * call. Two decision models pointed at the same `provider` + `baseUrl` would
 * otherwise leave the second one unregistered - `findOfType("classifier", ...)`
 * would return nothing for it and classification would report `unresolvable`.
 * `groupLocalEndpoints` does that grouping, and it considers decision models
 * that no virtual model references too, so an endpoint stays registered while a
 * model list is being edited.
 *
 * The transport is switchback's own rather than an import of pi's
 * `@earendil-works/pi-ai/api/typesafe-system-one.lazy`: pi supplies host
 * packages to extensions by bare specifier only, so a deep subpath resolves in
 * this repo but not in a package installed with `pi install`. See
 * src/systemone.ts.
 *
 * This runs inside the extension factory and performs no I/O: it only declares
 * a provider from static config, so `pi --list-models`, startup model selection
 * and `--api-key`-free local use all see it immediately.
 */

import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SYSTEM_ONE_API, systemOneClassifier } from "./systemone.ts";
import type { JevConfig } from "./types.ts";

/** The only System One wire protocol switchback drives directly today. */
export const LOCAL_CLASSIFIER_API = SYSTEM_ONE_API;

/**
 * Context window advertised for a locally registered classifier. System One
 * scoring does not generate tokens, so this only bounds the state we may send;
 * Ollama rejects requests beyond its loaded context.
 */
const LOCAL_CLASSIFIER_CONTEXT_WINDOW = 32_768;

/** True when the classifier block names its own endpoint instead of a pi catalog entry. */
export function isLocalClassifier(jev: JevConfig | undefined): boolean {
	return jev?.baseUrl !== undefined;
}

/** One direct endpoint and every classifier model that lives on it. */
export interface LocalClassifierEndpoint {
	/** Provider id written to the config. */
	provider: string;
	/** The System One base URL (`POST {baseUrl}/systemone`). */
	baseUrl: string;
	/**
	 * Bearer token for the endpoint. A local server ignores it, but the transport
	 * refuses to send without one, so it falls back to the provider id.
	 */
	apiKey: string;
	/** Distinct classifier models to register under this provider. */
	models: readonly JevConfig[];
}

/**
 * Group every direct endpoint in a config with all the classifier models that
 * share it. Entries without a `baseUrl` are catalog classifiers and are not
 * switchback's to register; they are skipped.
 *
 * Ordering follows first appearance, and a repeated `provider` + `baseUrl` +
 * model id collapses to one entry - the same classifier is often named by
 * several virtual models, and by a `decisionModels` entry as well.
 */
export function groupLocalEndpoints(jevs: readonly JevConfig[]): LocalClassifierEndpoint[] {
	const byEndpoint = new Map<string, { provider: string; baseUrl: string; apiKey?: string; models: JevConfig[] }>();
	for (const jev of jevs) {
		if (jev.baseUrl === undefined) continue;
		const key = `${jev.provider}|${jev.baseUrl}`;
		const group = byEndpoint.get(key) ?? { provider: jev.provider, baseUrl: jev.baseUrl, models: [] };
		if (group.apiKey === undefined && jev.apiKey !== undefined) group.apiKey = jev.apiKey;
		if (!group.models.some((model) => model.id === jev.id)) group.models.push(jev);
		byEndpoint.set(key, group);
	}
	return [...byEndpoint.values()].map((group) => ({
		provider: group.provider,
		baseUrl: group.baseUrl,
		apiKey: group.apiKey ?? group.provider,
		models: group.models,
	}));
}

/**
 * Register one direct endpoint as a classifier provider, carrying **all** its
 * classifier models. Call `groupLocalEndpoints` first; a no-op list means there
 * is nothing local to register and the classifier stays catalog-resolved.
 */
export function registerLocalClassifier(pi: ExtensionAPI, endpoint: LocalClassifierEndpoint): void {
	const { provider, baseUrl, apiKey } = endpoint;
	const models: ClassifierModel<ClassifierApi>[] = endpoint.models.map((jev) => ({
		type: "classifier",
		id: jev.id,
		name: `${jev.id} (switchback local classifier)`,
		api: LOCAL_CLASSIFIER_API,
		provider,
		baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: LOCAL_CLASSIFIER_CONTEXT_WINDOW,
	}));
	pi.registerProvider(provider, {
		baseUrl,
		apiKey,
		models,
		classifiers: { [SYSTEM_ONE_API]: systemOneClassifier(baseUrl, { apiKey }) },
	});
}
