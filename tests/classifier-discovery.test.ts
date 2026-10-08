/**
 * Tests for the live Ollama `/api/tags` discovery (`src/classifier-discovery.ts`).
 *
 * The transport is injected (FetchLike), so no real Ollama server is needed; the
 * fixture matches the shape Ollama v0.35 returns, and the tests assert the
 * decision-capable filter the model picker relies on.
 */

import { describe, expect, it } from "vitest";
import { decisionCapableModels, discoverOllamaModels, OllamaModelSummary } from "../src/classifier-discovery.ts";
import type { FetchLike } from "../src/systemone.ts";

const MODELS: OllamaModelSummary[] = [
	{ id: "nimble:latest", decisionCapable: true, capabilities: ["decision"] },
	{ id: "tev:latest", decisionCapable: false, capabilities: ["tools", "thinking", "completion", "vision"] },
	{ id: "kev-4b", decisionCapable: true, capabilities: ["decision", "completion"] },
];

/** A fetch that ignores the URL and returns a canned `/api/tags` body. */
function fakeTagsFetch(body: unknown): FetchLike {
	return async () => ({
		ok: true,
		status: 200,
		text: async () => JSON.stringify(body),
		json: async () => body,
	});
}

describe("classifier-discovery: Ollama /api/tags", () => {
	it("returns the model list and marks decision-capable ones", async () => {
		const fetch = fakeTagsFetch({
			models: [
				{ name: "nimble:latest", details: { capabilities: ["decision"] } },
				{ name: "tev:latest", details: { capabilities: ["tools", "thinking", "completion", "vision"] } },
			],
		});
		const result = await discoverOllamaModels({ baseUrl: "http://localhost:11434/v1", fetch });
		expect(result.error).toBeUndefined();
		expect(result.models.map((m) => m.id)).toEqual(["nimble:latest", "tev:latest"]);
		expect(result.models.find((m) => m.id === "nimble:latest")?.decisionCapable).toBe(true);
		expect(result.models.find((m) => m.id === "tev:latest")?.decisionCapable).toBe(false);
	});

	it("strips a trailing /v1 from the baseUrl before appending /api/tags", async () => {
		let seenUrl = "";
		const fetch: FetchLike = async (url) => {
			seenUrl = url;
			return { ok: true, status: 200, text: async () => "{}", json: async () => ({}) };
		};
		await discoverOllamaModels({ baseUrl: "http://localhost:11434/v1", fetch });
		expect(seenUrl).toBe("http://localhost:11434/api/tags");
	});

	it("reports a non-200 as an error and returns no models", async () => {
		const fetch: FetchLike = async () => ({
			ok: false,
			status: 500,
			text: async () => "",
			json: async () => ({}),
		});
		const result = await discoverOllamaModels({ baseUrl: "http://localhost:11434/v1", fetch });
		expect(result.models).toEqual([]);
		expect(result.error).toMatch(/500/);
	});

	it("returns an empty list with an error on network failure", async () => {
		const fetch: FetchLike = async () => {
			throw new Error("ECONNREFUSED");
		};
		const result = await discoverOllamaModels({ baseUrl: "http://localhost:11434/v1", fetch });
		expect(result.models).toEqual([]);
		expect(result.error).toBe("ECONNREFUSED");
	});
});

describe("classifier-discovery: filter", () => {
	it("keeps only decision-capable models, sorted", () => {
		expect(decisionCapableModels(MODELS)).toEqual(["kev-4b", "nimble:latest"]);
	});

	it("returns an empty array when nothing is decision-capable", () => {
		const only = MODELS.filter((m) => !m.decisionCapable);
		expect(decisionCapableModels(only)).toEqual([]);
	});
});
