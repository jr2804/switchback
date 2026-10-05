/**
 * Dedicated local classifier endpoint.
 *
 * pi can only classify through a classifier model that some provider
 * registered. Ollama v0.35+ serves System One models at `POST /v1/systemone`,
 * which speaks the same wire protocol as pi's `typesafe-system-one` transport,
 * but pi ships no Ollama classifier provider and `models.json` cannot express
 * one (its schema has no classifier model type). So switchback declares the
 * endpoint itself, from its own config: exactly one decision model, used only
 * by this extension.
 *
 * `jev.baseUrl` in `switchback.yaml` is the switch. When present, switchback
 * registers `jev.provider` with that one classifier model and its own System
 * One transport (src/systemone.ts), so the normal
 * `ctx.modelRegistry.classify()` path - block map, Tier 2b annotation cache,
 * reset scoring - works unchanged.
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

/**
 * Register the configured direct endpoint as a classifier provider. A no-op
 * when `jev.baseUrl` is absent (the classifier is then resolved from pi's own
 * catalog, as before).
 */
export function registerLocalClassifier(pi: ExtensionAPI, jev: JevConfig | undefined): void {
	if (jev === undefined || jev.baseUrl === undefined) return;
	const api: ClassifierApi = LOCAL_CLASSIFIER_API;
	const model: ClassifierModel<ClassifierApi> = {
		type: "classifier",
		id: jev.id,
		name: `${jev.id} (switchback local classifier)`,
		api,
		provider: jev.provider,
		baseUrl: jev.baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: LOCAL_CLASSIFIER_CONTEXT_WINDOW,
	};
	// A local server (Ollama) ignores the bearer token, but the header must be
	// non-empty, so default it to something deterministic.
	const apiKey = jev.apiKey ?? jev.provider;
	pi.registerProvider(jev.provider, {
		baseUrl: jev.baseUrl,
		apiKey,
		models: [model],
		classifiers: { [SYSTEM_ONE_API]: systemOneClassifier(jev.baseUrl, { apiKey }) },
	});
}
