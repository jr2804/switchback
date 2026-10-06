/**
 * Tests for the classifier provider catalog (`src/classifier-catalog.ts`).
 *
 * The module is pure: it turns pi's registry view into wizard choices. Nothing
 * in it names a provider, a base URL or a model id, so these fixtures stand in
 * for pi rather than for any particular vendor.
 */

import { describe, expect, it } from "vitest";
import {
	buildClassifierProviders,
	classifierBaseUrlNote,
	defaultDecisionModelName,
	directEndpointWouldClobber,
	type ClassifierProviderSource,
} from "../src/classifier-catalog.ts";

function provider(overrides: Partial<ClassifierProviderSource> & { id: string }): ClassifierProviderSource {
	return { name: overrides.id, classifiers: [], chatModels: 0, ...overrides };
}

describe("classifier-catalog: provider choices", () => {
	it("offers only providers that ship classifier models, sorted by id", () => {
		const options = buildClassifierProviders([
			provider({ id: "zeta", classifiers: [{ id: "z-2", api: "typesafe-system-one" }, { id: "z-1", api: "typesafe-system-one" }] }),
			provider({ id: "alpha", classifiers: [{ id: "a-1", api: "typesafe-system-one" }] }),
			provider({ id: "chat-only", chatModels: 12 }),
		]);
		expect(options.map((o) => o.provider)).toEqual(["alpha", "zeta"]);
		// Model ids are sorted so the picker order is stable across runs.
		expect(options[1]?.models).toEqual(["z-1", "z-2"]);
	});

	it("carries pi's display name and base URL through, inventing neither", () => {
		const options = buildClassifierProviders([
			provider({ id: "hosted", name: "Hosted Classifiers", baseUrl: "https://example.invalid/v1/", classifiers: [{ id: "m", api: "typesafe-system-one" }] }),
			provider({ id: "no-url", name: "No URL", classifiers: [{ id: "m", api: "typesafe-system-one" }] }),
		]);
		expect(options[0]).toMatchObject({
			provider: "hosted",
			label: "hosted — Hosted Classifiers",
			displayName: "Hosted Classifiers",
			baseUrl: "https://example.invalid/v1/",
			api: "typesafe-system-one",
			local: false,
		});
		// No declared URL means no `baseUrl` key at all - the config stays catalog-resolved.
		expect(options[1]?.baseUrl).toBeUndefined();
	});

	it("takes the wire api from the provider's own classifier models", () => {
		const options = buildClassifierProviders([
			provider({ id: "p", classifiers: [{ id: "m", api: "vendor-system-one" }] }),
		]);
		expect(options[0]?.api).toBe("vendor-system-one");
	});

	it("reports how many chat models pi already owns under the id", () => {
		const options = buildClassifierProviders([
			provider({ id: "shared", chatModels: 7, classifiers: [{ id: "m", api: "typesafe-system-one" }] }),
		]);
		expect(options[0]?.chatModels).toBe(7);
	});

	it("returns an empty list when no provider ships a classifier", () => {
		expect(buildClassifierProviders([provider({ id: "chat-only", chatModels: 3 })])).toEqual([]);
		expect(buildClassifierProviders([])).toEqual([]);
	});
});

describe("classifier-catalog: base URL notes", () => {
	it("points at pi's catalog when the provider declares no endpoint", () => {
		const [option] = buildClassifierProviders([provider({ id: "p", name: "P", classifiers: [{ id: "m", api: "typesafe-system-one" }] })]);
		expect(classifierBaseUrlNote(option!)).toMatch(/resolved from pi's model catalog/);
	});

	it("quotes pi's catalog value when there is one", () => {
		const [option] = buildClassifierProviders([
			provider({ id: "p", name: "P", baseUrl: "https://api.example/v1/", classifiers: [{ id: "m", api: "typesafe-system-one" }] }),
		]);
		const note = classifierBaseUrlNote(option!);
		expect(note).toMatch(/from pi's model catalog/);
		expect(note).toContain("https://api.example/v1/");
	});
});

describe("classifier-catalog: clobber guard", () => {
	it("flags a provider pi already serves chat models under", () => {
		// pi's `applyExtension` returns `config.models.map(...)` whenever an extension
		// registers a provider with a model list, so a direct endpoint here would drop
		// those chat models. Derived from the registry, not from a reserved-id list.
		const [busy] = buildClassifierProviders([
			provider({ id: "busy", chatModels: 4, classifiers: [{ id: "m", api: "typesafe-system-one" }] }),
		]);
		const [free] = buildClassifierProviders([
			provider({ id: "free", chatModels: 0, classifiers: [{ id: "m", api: "typesafe-system-one" }] }),
		]);
		expect(directEndpointWouldClobber(busy!)).toBe(true);
		expect(directEndpointWouldClobber(free!)).toBe(false);
	});
});

describe("classifier-catalog: suggested names", () => {
	it("derives a name from provider and model, flattening separators", () => {
		expect(defaultDecisionModelName("ollama", "parable/tinyjev:latest")).toBe("ollama-parable-tinyjev");
		expect(defaultDecisionModelName("typesafe", "jev-latest")).toBe("typesafe-jev");
		expect(defaultDecisionModelName("openrouter", "cloudflare/clef")).toBe("openrouter-cloudflare-clef");
	});
});
