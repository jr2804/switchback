/**
 * The classifier endpoints the config dialogue offers.
 *
 * The decision-model wizard used to ask for a provider id as free text, which
 * invites typos and hides the fact that a wrong id fails only at classification
 * time. What providers exist, what they are called and where they live is
 * knowledge pi already has: every classifier-capable provider is registered in
 * the model registry, with its display name and base URL. This module turns that
 * registry view into a choice list - switchback keeps no provider table of its
 * own beyond the two local endpoints pi does not know about.
 *
 * Local endpoints (Ollama's `/v1/systemone`, a llama.cpp server) are the one
 * case pi cannot supply, because they are not pi providers at all: switchback
 * registers them itself when `baseUrl` is present. Their defaults come from the
 * conventional environment variables (`OLLAMA_HOST`, `LLAMA_SERVER_URL`) and fall
 * back to the well-known local addresses, so the wizard can prefill a working
 * URL instead of asking the user to remember one.
 */

import { LOCAL_CLASSIFIER_APIS } from "./config.ts";

/** One choice in the decision-model wizard's provider step. */
export interface ClassifierProviderOption {
	/** Provider id written to the config. */
	provider: string;
	/** Choice label, e.g. "typesafe — TypeSafe". */
	label: string;
	/**
	 * Default base URL. Present for pi providers that declare one and for local
	 * endpoints; absent means "resolve from pi's catalog", i.e. no `baseUrl` key.
	 */
	baseUrl?: string;
	/**
	 * Wire API to write alongside `baseUrl`. Every local endpoint switchback knows
	 * speaks exactly one, so the wizard sets it from here instead of asking - the
	 * old "wire API? (none)" question offered a choice that does not exist.
	 */
	api?: string;
	/** Classifier model ids pi knows for this provider (empty: ask for an id). */
	models: readonly string[];
	/** True for a local SystemOne endpoint (switchback registers it itself). */
	local: boolean;
}

/** The local classifier endpoints pi does not provide. */
export interface LocalClassifierEndpoint {
	provider: string;
	name: string;
	/** Environment variable that overrides the address. */
	envVar: string;
	/** Address used when the environment variable is unset. */
	defaultBaseUrl: string;
	/** The wire API this endpoint speaks (the only one switchback supports today). */
	api: string;
}

/**
 * Local SystemOne endpoints, in the order they are offered. Both speak the same
 * wire API (switchback's own transport), so the wizard can set `api` for them.
 */
export const LOCAL_CLASSIFIER_ENDPOINTS: readonly LocalClassifierEndpoint[] = [
	{
		provider: "ollama",
		name: "Ollama (local SystemOne)",
		envVar: "OLLAMA_HOST",
		defaultBaseUrl: "http://localhost:11434/v1",
		api: LOCAL_CLASSIFIER_APIS[0] ?? "typesafe-system-one",
	},
	{
		provider: "llama-server",
		name: "llama.cpp server (local SystemOne)",
		envVar: "LLAMA_SERVER_URL",
		defaultBaseUrl: "http://localhost:8080/v1",
		api: LOCAL_CLASSIFIER_APIS[0] ?? "typesafe-system-one",
	},
];

/**
 * Normalize a host or URL from an environment variable into an OpenAI-style
 * `/v1` base URL: `127.0.0.1:11434` and `http://127.0.0.1:11434` both become
 * `http://127.0.0.1:11434/v1`, and a value that already carries a path is kept
 * (minus a trailing slash).
 */
export function normalizeLocalBaseUrl(value: string): string | undefined {
	const trimmed = value.trim();
	if (trimmed.length === 0) return undefined;
	// Any explicit scheme is honoured only if it is http(s); anything else is treated
	// as a bare host ("127.0.0.1:11434").
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed) ? trimmed : `http://${trimmed}`;
	let parsed: URL;
	try {
		parsed = new URL(withScheme);
	} catch {
		return undefined;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
	const path = parsed.pathname.replace(/\/+$/u, "");
	return `${parsed.origin}${path === "" ? "/v1" : path}`;
}

export interface ClassifierProviderSource {
	/** Registered providers, as pi's registry reports them. */
	providers: readonly { id: string; name: string; baseUrl?: string }[];
	/** Classifier model ids pi knows for a provider (empty when none). */
	classifierIds: (provider: string) => readonly string[];
	/** Environment for the local-endpoint defaults. Defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/**
 * Build the provider choices: every classifier-capable pi provider first
 * (alphabetically, with its own display name and base URL), then the local
 * endpoints with their environment-derived defaults. A provider pi lists but
 * that declares no base URL keeps `baseUrl` undefined, which is the correct
 * config for a catalog-resolved classifier.
 */
export function buildClassifierProviders(source: ClassifierProviderSource): ClassifierProviderOption[] {
	const env = source.env ?? process.env;
	const catalog: ClassifierProviderOption[] = [];
	for (const provider of source.providers) {
		const models = source.classifierIds(provider.id);
		if (models.length === 0) continue;
		catalog.push({
			provider: provider.id,
			label: `${provider.id} — ${provider.name}`,
			...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
			models: [...models].sort(),
			local: false,
		});
	}
	catalog.sort((a, b) => a.provider.localeCompare(b.provider));

	const local: ClassifierProviderOption[] = LOCAL_CLASSIFIER_ENDPOINTS.map((endpoint) => {
		const fromEnv = env[endpoint.envVar];
		const baseUrl =
			(fromEnv !== undefined ? normalizeLocalBaseUrl(fromEnv) : undefined) ?? endpoint.defaultBaseUrl;
		return {
			provider: endpoint.provider,
			label: `${endpoint.provider} — ${endpoint.name}`,
			baseUrl,
			api: endpoint.api,
			models: [],
			local: true,
		};
	});

	return [...catalog, ...local];
}

/**
 * A short note for a choice's screen title: where the base URL default came
 * from, so a prefilled value is explainable rather than magic.
 */
export function classifierBaseUrlNote(option: ClassifierProviderOption, env: Record<string, string | undefined> = process.env): string {
	if (option.baseUrl === undefined) return "resolved from pi's model catalog (no baseUrl needed)";
	const endpoint = LOCAL_CLASSIFIER_ENDPOINTS.find((candidate) => candidate.provider === option.provider);
	if (endpoint === undefined) return `provider default: ${option.baseUrl}`;
	const fromEnv = env[endpoint.envVar];
	return fromEnv !== undefined && normalizeLocalBaseUrl(fromEnv) === option.baseUrl
		? `from ${endpoint.envVar}`
		: `default (set ${endpoint.envVar} to override)`;
}
