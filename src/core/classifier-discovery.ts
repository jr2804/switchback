/**
 * Live discovery of System One-compatible models from a local Ollama server.
 *
 * Ollama v0.35+ advertises model capabilities in `/api/tags`, and a model that
 * can answer the Jev System One prompt is listed with `"decision"` in its
 * capabilities array. The wizard surfaces those ids in the model step, so a
 * freshly configured endpoint does not have to wait for a routing failure to
 * discover the wrong model id.
 *
 * llama-server (llama.cpp) has no equivalent endpoint, so the wizard falls back
 * to "type the model id" for that endpoint. Future work may add a /v1/models
 * shim there.
 */

import type { FetchLike } from "./systemone.ts";

/** One Ollama model as `/api/tags` reports it. */
export interface OllamaModelSummary {
	/** The model id as Ollama writes it (e.g. `nimble:latest`). */
	id: string;
	/** True iff the model lists `"decision"` in its capabilities. */
	decisionCapable: boolean;
	/** All advertised capabilities, for diagnostics. */
	capabilities: readonly string[];
}

/** The default probe timeout for one `/api/tags` request. */
export const OLLAMA_DISCOVERY_TIMEOUT_MS = 10_000;

/** Shape we read from `/api/tags`. */
interface OllamaTagsResponse {
	models?: Array<{
		name?: string;
		model?: string;
		details?: { capabilities?: string[] };
		capabilities?: string[];
	}>;
}

/**
 * One `/api/tags` round-trip against a local Ollama server. The caller supplies
 * the Ollama root (e.g. `http://localhost:11434`), not the System One base URL -
 * Ollama's `/api/tags` lives at the root regardless of the System One endpoint's
 * `/v1` prefix.
 *
 * Returns the empty array on any error (network failure, non-200, malformed
 * body) and leaves the error to the caller via the `error` field on the result.
 * The wizard prefers "show what we know" over a hard failure when discovery is
 * best-effort.
 */
export async function discoverOllamaModels(opts: {
	baseUrl: string;
	fetch?: FetchLike;
	timeoutMs?: number;
}): Promise<{ models: OllamaModelSummary[]; error?: string }> {
	const timeoutMs = opts.timeoutMs ?? OLLAMA_DISCOVERY_TIMEOUT_MS;
	const url = ollamaTagsUrl(opts.baseUrl);
	const fetchImpl = opts.fetch ?? globalThis.fetch;
	if (typeof fetchImpl !== "function") {
		return { models: [], error: "no fetch implementation available" };
	}
	try {
		const response = await fetchImpl(url, {
			method: "GET",
			headers: { accept: "application/json" },
			body: "",
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!response.ok) {
			return { models: [], error: `ollama /api/tags ${response.status}` };
		}
		const json = (await response.json()) as OllamaTagsResponse;
		const models: OllamaModelSummary[] = [];
		for (const entry of json.models ?? []) {
			const id = entry.name ?? entry.model;
			if (typeof id !== "string" || id.length === 0) continue;
			const capsRaw = entry.capabilities ?? entry.details?.capabilities ?? [];
			const capabilities = capsRaw.filter((cap): cap is string => typeof cap === "string");
			models.push({
				id,
				decisionCapable: capabilities.includes("decision"),
				capabilities,
			});
		}
		return { models };
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : String(cause);
		return { models: [], error: message };
	}
}

/**
 * The `/api/tags` URL for a given Ollama root. Accepts roots in either form
 * (`http://localhost:11434` or `http://localhost:11434/v1`); both work because
 * `/api/tags` is not under the System One `/v1` prefix.
 */
function ollamaTagsUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
	return `${trimmed}/api/tags`;
}

/**
 * Filter the discover result to System One-capable models only, sorted by id.
 * The wizard uses this to populate the model picker; a model without the
 * capability is offered under "Other (type the model id)" so they can still be
 * entered by hand for testing.
 */
export function decisionCapableModels(models: readonly OllamaModelSummary[]): string[] {
	return models
		.filter((m) => m.decisionCapable)
		.map((m) => m.id)
		.sort();
}
