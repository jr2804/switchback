/**
 * Reasoning-level resolution (src/thinking.ts).
 *
 * switchback offers one fixed category scale - off, minimal, medium, high, max -
 * on every virtual model, and the SystemOne classifier resolves the user's
 * category against the concrete model that was activated, because the physical
 * models' thinking-level maps differ (zai has no `medium` and cannot disable
 * thinking at all; MiniMax has no map and honours everything up to `high`).
 *
 * Hermetic: the classifier is a stub, so these never touch the network.
 */

import { describe, expect, it } from "vitest";
import type { Api, ClassifierContext, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import {
	availableCategories,
	chooseThinkingLevel,
	SWITCHBACK_THINKING_LEVELS,
	type ThinkingLevelContext,
} from "../src/thinking.ts";
import type { ClassifierRegistry } from "../src/classify.ts";

const CONTEXT: ThinkingLevelContext = { routeReason: "user", failover: false };

/** The real thinking-level map of zai GLM 5.3 and opencode-go deepseek-v4.1-flash. */
const ZAI_MAP = { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" };

function model(id: string, opts: { reasoning?: boolean; thinkingLevelMap?: Record<string, string | null> } = {}): Model<Api> {
	return {
		type: "chat",
		provider: "zai",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		reasoning: opts.reasoning ?? true,
		...(opts.thinkingLevelMap ? { thinkingLevelMap: opts.thinkingLevelMap } : {}),
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_000,
	};
}

function classifier(level: string | undefined, calls: string[] = []): ClassifierRegistry {
	return {
		findOfType: (_type, provider, id) => ({ provider, id, api: "classifier", input: ["text"] }) as never,
		classify: async (_model, context: ClassifierContext) => {
			calls.push(Object.keys(context.questions).join(","));
			if (level === undefined) return null as never;
			return { stopReason: "stop", answers: { level: { type: "choice", choice: level, probabilities: {}, confidence: 1 } } } as never;
		},
	};
}

const JEV = { provider: "typesafe", id: "jev-latest" };

describe("switchback thinking categories", () => {
	it("is the fixed five-level scale", () => {
		expect([...SWITCHBACK_THINKING_LEVELS]).toEqual(["off", "minimal", "medium", "high", "max"]);
	});
});

describe("availableCategories", () => {
	it("intersects the model's supported levels with the switchback scale", () => {
		// zai supports low/high/max only: `low` is outside our scale, and off /
		// minimal / medium do not exist on the model.
		expect(availableCategories(model("glm-5.3", { thinkingLevelMap: ZAI_MAP }))).toEqual(["high", "max"]);
	});

	it("offers everything up to high when the model carries no map", () => {
		// MiniMax / mimo: reasoning model without a thinkingLevelMap. `xhigh` and
		// `max` need an explicit map entry, so they are not supported.
		expect(availableCategories(model("MiniMax-M3"))).toEqual(["off", "minimal", "medium", "high"]);
	});

	it("offers only off for a non-reasoning model", () => {
		expect(availableCategories(model("plain", { reasoning: false }))).toEqual(["off"]);
	});
});

describe("chooseThinkingLevel", () => {
	it("uses the classifier's recommended level when it is one the model supports", async () => {
		const choice = await chooseThinkingLevel({
			registry: classifier("max"),
			jev: JEV,
			model: model("glm-5.3", { thinkingLevelMap: ZAI_MAP }),
			requested: "medium",
			context: CONTEXT,
		});
		expect(choice.level).toBe("max");
		expect(choice.source).toBe("classifier");
		expect(choice.reason).toBeUndefined();
	});

	it("clamps the requested category when the classifier is not configured", async () => {
		const choice = await chooseThinkingLevel({
			registry: classifier("max"),
			jev: undefined,
			model: model("glm-5.3", { thinkingLevelMap: ZAI_MAP }),
			requested: "off",
			context: CONTEXT,
		});
		// Without a classifier the category is clamped, not rounded to another
		// category: zai cannot disable thinking, so `off` resolves upward to its own
		// lowest level, `low` - the same level pi would have dispatched.
		expect(choice.level).toBe("low");
		expect(choice.source).toBe("requested");
		expect(choice.reason).toBe("not-configured");
	});

	it("ignores a level the model does not support and clamps instead", async () => {
		const choice = await chooseThinkingLevel({
			registry: classifier("medium"),
			jev: JEV,
			model: model("glm-5.3", { thinkingLevelMap: ZAI_MAP }),
			requested: "medium",
			context: CONTEXT,
		});
		expect(choice.level).toBe("high");
		expect(choice.source).toBe("requested");
		expect(choice.reason).toBe("unparseable");
	});

	it("does not call the classifier when the model offers a single category", async () => {
		const calls: string[] = [];
		const choice = await chooseThinkingLevel({
			registry: classifier("off", calls),
			jev: JEV,
			model: model("plain", { reasoning: false }),
			requested: "medium" as ModelThinkingLevel,
			context: CONTEXT,
		});
		expect(choice.level).toBe("off");
		expect(calls).toHaveLength(0);
	});

	it("passes the model, its supported levels and the route context to the classifier", async () => {
		let seen: ClassifierContext | undefined;
		const registry: ClassifierRegistry = {
			findOfType: (_type, provider, id) => ({ provider, id, api: "classifier", input: ["text"] }) as never,
			classify: async (_model, context) => {
				seen = context;
				return { stopReason: "stop", answers: { level: { type: "choice", choice: "high", probabilities: {}, confidence: 1 } } } as never;
			},
		};
		await chooseThinkingLevel({
			registry,
			jev: JEV,
			model: model("glm-5.3", { thinkingLevelMap: ZAI_MAP }),
			requested: "medium",
			context: { routeReason: "retry", failover: true },
		});
		expect(seen?.state).toMatchObject({
			model: "zai/glm-5.3",
			requested_category: "medium",
			model_supported_levels: "high, max",
			route_reason: "retry",
			failover: "yes",
		});
		expect(Object.keys(seen?.questions ?? {})).toEqual(["level"]);
	});

	it("always returns a level the model supports, whatever the requested category", async () => {
		const target = model("glm-5.3", { thinkingLevelMap: ZAI_MAP });
		for (const requested of SWITCHBACK_THINKING_LEVELS) {
			const choice = await chooseThinkingLevel({
				registry: classifier("max"),
				jev: JEV,
				model: target,
				requested,
				context: CONTEXT,
			});
			expect(availableCategories(target)).toContain(choice.level);
		}
	});
});
