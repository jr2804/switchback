/**
 * Tests for the OpenCode decision-model connection check
 * (`packages/opencode/src/decision-model-check.ts`).
 *
 * OpenCode publishes no classifier catalog, so a referenced decision-model
 * address is only usable when it carries (or inherits) a baseUrl. These tests
 * pin the message and, just as importantly, the silence: an address that
 * resolves through `decisionProviders` must not warn, or the check would nag
 * about a correctly configured classifier on every session start.
 */

import { describe, expect, it } from "vitest";
import { findUnconnectedDecisionModels } from "../packages/opencode/src/decision-model-check.ts";
import type { ResolvedSwitchbackFileConfig } from "../packages/core/src/types.ts";

/** A resolved config with one virtual model whose decision model is `address`. */
function configWith(address: string, extra: Partial<ResolvedSwitchbackFileConfig>): ResolvedSwitchbackFileConfig {
	const [provider, id] = address.split("/");
	return {
		models: [
			{
				id: "switchback/auto",
				name: "Auto",
				fallbacks: ["zai/glm-5.3"],
				decisionModel: { provider: provider ?? "", id: id ?? "" },
			},
		],
		...extra,
	} as unknown as ResolvedSwitchbackFileConfig;
}

describe("findUnconnectedDecisionModels", () => {
	it("warns once for a referenced address with no baseUrl", () => {
		const warnings = findUnconnectedDecisionModels(configWith("typesafe/jev-latest", {}));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('decision model "typesafe/jev-latest"');
		expect(warnings[0]).toContain("decisionProviders.typesafe");
	});

	it("stays silent when the provider section carries the connection", () => {
		const warnings = findUnconnectedDecisionModels(
			configWith("typesafe/jev-latest", { decisionProviders: { typesafe: { baseUrl: "https://api.typesafe.ai/v1/" } } }),
		);
		expect(warnings).toEqual([]);
	});

	it("stays silent when the address has its own override", () => {
		const warnings = findUnconnectedDecisionModels(
			configWith("ollama/tev1", { decisionModels: { "ollama/tev1": { baseUrl: "http://localhost:11434/v1" } } }),
		);
		expect(warnings).toEqual([]);
	});

	it("warns when the provider section exists but has no baseUrl", () => {
		// A provider entry without a baseUrl is an empty override, not a connection.
		const warnings = findUnconnectedDecisionModels(
			configWith("typesafe/jev-latest", { decisionProviders: { typesafe: {} } }),
		);
		expect(warnings).toHaveLength(1);
	});

	it("ignores virtual models without a decision model", () => {
		const config = {
			models: [{ id: "switchback/auto", name: "Auto", fallbacks: ["zai/glm-5.3"] }],
		} as unknown as ResolvedSwitchbackFileConfig;
		expect(findUnconnectedDecisionModels(config)).toEqual([]);
	});
});
