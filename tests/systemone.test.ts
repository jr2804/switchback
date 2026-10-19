/**
 * Unit tests for switchback's System One transport (packages/core/src/systemone.ts),
 * which delegates the wire call to `@typesafe-ai/sdk`.
 *
 * Hermetic: fetch is injected, so these never touch the network. The live
 * end-to-end path is covered separately by tests/integration-classifier.test.ts
 * (opt-in, real transport) and by manual install verification.
 */

import { describe, expect, it } from "vitest";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { systemOneClassifier, type FetchLike } from "switchback-core/systemone.ts";

const MODEL: ClassifierModel<ClassifierApi> = {
	type: "classifier",
	id: "tev1:0.8b",
	name: "tev1:0.8b",
	api: "typesafe-system-one",
	provider: "ollama",
	baseUrl: "http://localhost:11434/v1",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
};

interface Captured {
	url: string;
	init: { method: string; headers: Headers; body: string };
}

function stubFetch(body: unknown, status = 200): { fetch: FetchLike; captured: Captured[] } {
	const captured: Captured[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		captured.push({
			url: String(url),
			init: { method: init?.method ?? "", headers: new Headers(init?.headers), body: String(init?.body ?? "") },
		});
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: fetchImpl, captured };
}

const CONTEXT = {
	state: { prompt: "429 Too Many Requests: quota exceeded." },
	questions: {
		class: {
			type: "choice" as const,
			instructions: "Classify the failure.",
			criteria: { quota: "budget", auth: "credentials", transient: "network" },
		},
		reset: { type: "score" as const, instructions: "How soon does it reset?", criteria: ["now", "soon", "later"] },
		more: { type: "bool" as const, instructions: "Is there more?", criteria: { true: "yes", false: "no" } },
	},
};

describe("systemOneClassifier", () => {
	it("posts to /systemone, maps bool to noul, and parses every answer type", async () => {
		const { fetch, captured } = stubFetch({
			model: "tev1:0.8b",
			usage: { input_tokens: 12, output_tokens: 3 },
			answers: {
				class: { type: "choice", choice: "quota", probabilities: { quota: 0.9, auth: 0.1 }, confidence: 0.8 },
				reset: { type: "score", score: 2.5, confidence: 0.7 },
				more: { type: "noul", noul: 0.25 },
			},
		});
		const result = await systemOneClassifier("http://localhost:11434/v1", { apiKey: "ollama", fetch }).classify(
			MODEL,
			CONTEXT,
		);

		expect(captured).toHaveLength(1);
		// The SDK takes an API root and appends `/v1/systemone` itself; switchback's
		// baseUrl convention carries the `/v1`, so the transport strips it first.
		expect(captured[0]?.url).toBe("http://localhost:11434/v1/systemone");
		expect(captured[0]?.init.method).toBe("POST");
		expect(captured[0]?.init.headers.get("authorization")).toBe("Bearer ollama");
		const payload = JSON.parse(captured[0]!.init.body) as {
			model: string;
			state: unknown;
			questions: Record<string, { type: string }>;
		};
		expect(payload.model).toBe("tev1:0.8b");
		expect(payload.state).toEqual(CONTEXT.state);
		// `bool` is a public question type; the wire calls it `noul`.
		expect(payload.questions["more"]?.type).toBe("noul");
		expect(payload.questions["class"]?.type).toBe("choice");

		expect(result.stopReason).toBe("stop");
		expect(result.answers["class"]).toEqual({
			type: "choice",
			choice: "quota",
			probabilities: { quota: 0.9, auth: 0.1 },
			confidence: 0.8,
		});
		expect(result.answers["reset"]).toEqual({ type: "score", score: 2.5, confidence: 0.7 });
		expect(result.answers["more"]).toEqual({ type: "bool", probability: 0.25 });
	});

	it("trims a trailing slash and the version segment instead of doubling it", async () => {
		const { fetch, captured } = stubFetch({ answers: {} });
		await systemOneClassifier("http://127.0.0.1:8080/v1/", { apiKey: "k", fetch }).classify(MODEL, {
			state: {},
			questions: { q: { type: "score" as const, instructions: "Pick.", criteria: ["a", "b"] } },
		});
		expect(captured[0]?.url).toBe("http://127.0.0.1:8080/v1/systemone");
	});

	it("returns an error result (never rejects) on a non-OK response", async () => {
		const { fetch } = stubFetch({ error: "does not support decision" }, 400);
		const result = await systemOneClassifier("http://localhost:11434/v1", { apiKey: "ollama", fetch }).classify(
			MODEL,
			CONTEXT,
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("400");
		expect(result.errorMessage).toContain("does not support decision");
		expect(result.answers).toEqual({});
	});

	it("returns an error result when the answer is missing or malformed", async () => {
		const { fetch } = stubFetch({ answers: { class: { type: "choice" } } });
		const result = await systemOneClassifier("http://localhost:11434/v1", { apiKey: "ollama", fetch }).classify(
			MODEL,
			CONTEXT,
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("did not return a choice answer");
	});

	it("returns an error result when no API key is available", async () => {
		const { fetch, captured } = stubFetch({ answers: {} });
		const result = await systemOneClassifier("http://localhost:11434/v1", { fetch }).classify(MODEL, CONTEXT);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("No API key");
		expect(captured).toHaveLength(0);
	});
});
