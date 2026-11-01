/**
 * Tests for the decision-model existence check
 * (`packages/pi/src/decision-model-check.ts`).
 *
 * The check exists because a decision-model id that the registry cannot resolve
 * (a typo like `tev2` for `tev1`, a model deleted from the local Ollama, a
 * catalog rename) otherwise surfaces only as silent blind cycling. These tests
 * pin the three observable behaviours: referenced addresses are collected and
 * de-duplicated, a resolvable address produces no warning, and a missing or
 * malformed one produces exactly one actionable warning. The router's
 * no-classifier fallback itself is covered by the router suites.
 */

import { describe, expect, it } from "vitest";
import { findUnresolvedDecisionModels } from "../packages/pi/src/decision-model-check.ts";
import {
	referencedDecisionModelAddresses,
	splitDecisionModelAddress,
} from "../packages/core/src/classifier-connection.ts";
import { resolveDecisionModel } from "../packages/core/src/config.ts";
import type { ClassifierPort, HostModel } from "../packages/core/src/ports.ts";
import type { ResolvedSwitchbackFileConfig } from "../packages/core/src/types.ts";

/** A registry that knows exactly these classifier addresses. */
function registryWith(known: readonly string[]): ClassifierPort {
	const set = new Set(known);
	return {
		findOfType: (_type, provider, id) =>
			set.has(`${provider}/${id}`) ? ({ provider, id } as unknown as HostModel) : undefined,
	} as unknown as ClassifierPort;
}

function configWith(...decisionModels: (string | undefined)[]): ResolvedSwitchbackFileConfig {
	return {
		models: decisionModels.map((decisionModel) => ({
			id: "switchback/auto",
			name: "Auto",
			fallbacks: ["zai/glm-5.3"],
			...(decisionModel === undefined
				? {}
				: {
						// The resolved config carries the address as an object (packages/core/src/types.ts).
						decisionModel: {
							provider: decisionModel.split("/")[0]!,
							id: decisionModel.split("/").slice(1).join("/"),
						},
					}),
		})),
	} as unknown as ResolvedSwitchbackFileConfig;
}

describe("decision-model check: address handling", () => {
	it("splits provider/id and rejects malformed addresses", () => {
		expect(splitDecisionModelAddress("typesafe/jev-latest")).toEqual({ provider: "typesafe", id: "jev-latest" });
		expect(splitDecisionModelAddress("ollama/tev1:0.8b")).toEqual({ provider: "ollama", id: "tev1:0.8b" });
		expect(splitDecisionModelAddress("noid")).toBeUndefined();
		expect(splitDecisionModelAddress("/leading")).toBeUndefined();
		expect(splitDecisionModelAddress("trailing/")).toBeUndefined();
	});

	it("collects the referenced addresses, de-duplicated", () => {
		const config = configWith("typesafe/jev-latest", "ollama/tev1", "typesafe/jev-latest");
		expect(referencedDecisionModelAddresses(config)).toEqual(["typesafe/jev-latest", "ollama/tev1"]);
	});

	it("returns nothing when no model references a decision model", () => {
		expect(referencedDecisionModelAddresses(configWith(undefined, undefined))).toEqual([]);
	});
});

describe("decision-model check: resolution", () => {
	it("stays silent when every referenced address resolves", () => {
		const warnings = findUnresolvedDecisionModels(
			registryWith(["typesafe/jev-latest", "ollama/tev1"]),
			configWith("typesafe/jev-latest", "ollama/tev1"),
		);
		expect(warnings).toEqual([]);
	});

	it("warns when the registry does not know the id (the tev2 case)", () => {
		// The registry knows tev1, the config asks for tev2: exactly the typo this
		// check exists for.
		const warnings = findUnresolvedDecisionModels(
			registryWith(["ollama/tev1"]),
			configWith("ollama/tev2"),
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('decision model "ollama/tev2" was not found');
		expect(warnings[0]).toContain("blind cycling");
	});

	it("accepts an id the host serves under the :latest alias", () => {
		// Ollama serves `tev1` as `tev1:latest`; both forms must resolve.
		const warnings = findUnresolvedDecisionModels(registryWith(["ollama/tev1:latest"]), configWith("ollama/tev1"));
		expect(warnings).toEqual([]);
	});

	it("warns on a malformed address instead of throwing", () => {
		const warnings = findUnresolvedDecisionModels(registryWith([]), configWith("noid"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("malformed");
	});

	it("skips an address that carries connection details - it resolves itself", () => {
		// A direct endpoint (own entry or provider section) publishes no model list,
		// so the registry has nothing to say about it. The empty registry below would
		// otherwise flag both addresses as missing.
		const config = {
			...configWith("gpu-ollama/tev9", "typesafe/jev-latest"),
			decisionModels: { "gpu-ollama/tev9": { baseUrl: "http://gpu:11434/v1" } },
			decisionProviders: { typesafe: { baseUrl: "https://api.typesafe.ai/v1/" } },
		} as unknown as ResolvedSwitchbackFileConfig;
		expect(findUnresolvedDecisionModels(registryWith([]), config)).toEqual([]);
	});

	it("treats an empty override as shadowing the provider entry (whole-entry precedence)", () => {
		// `decisionModels: {"gpu-ollama/tev9": {}}` is not "fall through to the
		// provider" - the override replaces the entry entirely, so the address is
		// catalog-resolved again and the registry check DOES apply to it.
		const config = {
			...configWith("gpu-ollama/tev9"),
			decisionModels: { "gpu-ollama/tev9": {} },
			decisionProviders: { "gpu-ollama": { baseUrl: "http://gpu:11434/v1" } },
		} as unknown as ResolvedSwitchbackFileConfig;
		const warnings = findUnresolvedDecisionModels(registryWith([]), config);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"gpu-ollama/tev9" was not found');
	});

	it("keeps the address resolvable when the decisionModels map has no such entry (the integration seam)", () => {
		// resolveDecisionModel deliberately returns the address split even when the
		// map lacks the entry - a dangling reference must reach the check instead of
		// being dropped, or the typo case would stay silent (the reported tev2 bug).
		const resolved = resolveDecisionModel({ "ollama/tev1": { provider: "ollama", id: "tev1" } }, "ollama/tev2");
		expect(resolved).toEqual({ provider: "ollama", id: "tev2" });
		const warnings = findUnresolvedDecisionModels(registryWith(["ollama/tev1"]), configWith("ollama/tev2"));
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('"ollama/tev2"');
	});
});
