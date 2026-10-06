/**
 * Tests for the context-fit helpers and the candidate-choice question
 * (`src/context-fit.ts`).
 *
 * Hermetic: the classifier registry is a stub, so the question's contract - what
 * is asked, what is accepted, what happens when nothing usable comes back - is
 * pinned without a network or a terminal.
 */

import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	chooseContextCandidate,
	fitsContext,
	usableContextTokens,
	CONTEXT_FIT_RESERVE_TOKENS,
} from "../src/context-fit.ts";
import type { ClassifierRegistry } from "../src/classify.ts";

function model(contextWindow: number): Model<Api> {
	return { provider: "zai", id: "m", contextWindow } as unknown as Model<Api>;
}

/** A registry whose classifier answers the candidate question with `choice`. */
function registryAnswering(choice: string | undefined): ClassifierRegistry {
	return {
		find: () => undefined,
		findOfType: () =>
			({ provider: "typesafe", id: "jev-latest", api: "classifier", input: ["text"] }) as unknown as ReturnType<
				ClassifierRegistry["findOfType"]
			>,
		classify: async (_model: unknown, context: unknown) => {
			if (choice === undefined) return null;
			const asked = (context as { questions?: Record<string, unknown> }).questions ?? {};
			if (!("candidate" in asked)) return null;
			return {
				stopReason: "stop" as const,
				answers: { candidate: { type: "choice" as const, choice, probabilities: {}, confidence: 0.8 } },
			};
		},
	} as unknown as ClassifierRegistry;
}

const CANDIDATES = [
	{ id: "zai/glm-5.3", contextWindow: 1_000_000 },
	{ id: "minimax/MiniMax-M3", contextWindow: 400_000 },
];

const input = (overrides: Partial<Parameters<typeof chooseContextCandidate>[0]> = {}) => ({
	registry: registryAnswering("minimax/MiniMax-M3"),
	jev: { provider: "typesafe", id: "jev-latest" },
	preferred: "zai/glm-5.3",
	contextTokens: 300_000,
	candidates: CANDIDATES,
	reason: "failover",
	failed: "opencode-go/mimo-v2.6-flash",
	...overrides,
});

describe("context-fit: window arithmetic", () => {
	it("reserves headroom for the response", () => {
		expect(usableContextTokens(model(128_000))).toBe(128_000 - CONTEXT_FIT_RESERVE_TOKENS);
		expect(fitsContext(model(128_000), 100_000)).toBe(true);
		// A model that only just fits would compact immediately, so it does not fit.
		expect(fitsContext(model(100_000), 100_000)).toBe(false);
		expect(usableContextTokens(model(1_000))).toBe(0);
	});
});

describe("context-fit: candidate choice", () => {
	it("follows the classifier when it picks another eligible candidate", async () => {
		const choice = await chooseContextCandidate(input());
		expect(choice).toEqual({ modelId: "minimax/MiniMax-M3", source: "classifier", confidence: 0.8 });
	});

	it("does not ask when only one candidate is eligible", async () => {
		const choice = await chooseContextCandidate(input({ candidates: [CANDIDATES[0]!] }));
		expect(choice).toEqual({ modelId: "zai/glm-5.3", source: "preferred" });
	});

	it("keeps the deterministic pick when the classifier is unavailable", async () => {
		const choice = await chooseContextCandidate(input({ registry: { find: () => undefined, findOfType: () => undefined, classify: async () => null } as unknown as ClassifierRegistry }));
		expect(choice.modelId).toBe("zai/glm-5.3");
		expect(choice.source).toBe("preferred");
		expect(choice.reason).toBe("unresolvable");
	});

	it("keeps the deterministic pick when the answer is unreadable or not offered", async () => {
		const silent = await chooseContextCandidate(input({ registry: registryAnswering(undefined) }));
		expect(silent.modelId).toBe("zai/glm-5.3");
		expect(silent.reason).toBe("timeout");
		const outside = await chooseContextCandidate(input({ registry: registryAnswering("ollama-cloud/glm-5.3-flash") }));
		expect(outside.modelId).toBe("zai/glm-5.3");
		expect(outside.reason).toBe("unparseable");
	});

	it("keeps the deterministic pick when it is not among the candidates", async () => {
		const choice = await chooseContextCandidate(input({ preferred: "opencode-go/mimo-v2.6-flash" }));
		expect(choice).toEqual({ modelId: "opencode-go/mimo-v2.6-flash", source: "preferred" });
	});
});
