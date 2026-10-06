/**
 * Unit tests for the classifier endpoint catalog (`src/classifier-catalog.ts`).
 *
 * Pure: the registry view, the environment and the local-endpoint table are all
 * inputs, so nothing here touches pi or the filesystem.
 */

import { describe, expect, it } from "vitest";
import {
	buildClassifierProviders,
	classifierBaseUrlNote,
	normalizeLocalBaseUrl,
	LOCAL_CLASSIFIER_ENDPOINTS,
} from "../src/classifier-catalog.ts";

const PROVIDERS = [
	{ id: "typesafe", name: "TypeSafe", baseUrl: "https://api.typesafe.ai/v1/" },
	{ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
	{ id: "anthropic", name: "Anthropic" },
];

const CLASSIFIERS: Record<string, string[]> = {
	typesafe: ["jev-latest", "jev-1.13"],
	openrouter: ["typesafe/jev-1.13"],
	anthropic: [],
};

const source = (env: Record<string, string | undefined> = {}) => ({
	providers: PROVIDERS,
	classifierIds: (provider: string) => CLASSIFIERS[provider] ?? [],
	env,
});

describe("classifier-catalog: provider choices", () => {
	it("offers only providers pi reports classifier models for, with their base URLs", () => {
		const options = buildClassifierProviders(source());
		const catalog = options.filter((option) => !option.local);
		expect(catalog.map((option) => option.provider)).toEqual(["openrouter", "typesafe"]);
		expect(catalog[0]?.label).toBe("openrouter — OpenRouter");
		expect(catalog[1]?.baseUrl).toBe("https://api.typesafe.ai/v1/");
		// A provider with no classifier models is not offered at all.
		expect(catalog.some((option) => option.provider === "anthropic")).toBe(false);
		// Known classifier ids are sorted and carried for the model step.
		expect(catalog[1]?.models).toEqual(["jev-1.13", "jev-latest"]);
	});

	it("appends the local SystemOne endpoints with their defaults and wire api", () => {
		const options = buildClassifierProviders(source());
		const local = options.filter((option) => option.local);
		expect(local.map((option) => option.provider)).toEqual(LOCAL_CLASSIFIER_ENDPOINTS.map((e) => e.provider));
		expect(local[0]?.baseUrl).toBe("http://localhost:11434/v1");
		expect(local[0]?.api).toBe("typesafe-system-one");
		expect(local[0]?.models).toEqual([]);
	});

	it("prefers the environment address for a local endpoint", () => {
		const options = buildClassifierProviders(source({ OLLAMA_HOST: "192.168.1.5:11434" }));
		const ollama = options.find((option) => option.provider === "ollama");
		expect(ollama?.baseUrl).toBe("http://192.168.1.5:11434/v1");
		// An unusable value falls back to the well-known default rather than a bad URL.
		const broken = buildClassifierProviders(source({ OLLAMA_HOST: "not a url at all" }));
		expect(broken.find((option) => option.provider === "ollama")?.baseUrl).toBe("http://localhost:11434/v1");
	});
});

describe("classifier-catalog: local base URL normalization", () => {
	it("adds the scheme and the /v1 path, and keeps an explicit path", () => {
		expect(normalizeLocalBaseUrl("127.0.0.1:11434")).toBe("http://127.0.0.1:11434/v1");
		expect(normalizeLocalBaseUrl("http://localhost:11434")).toBe("http://localhost:11434/v1");
		expect(normalizeLocalBaseUrl("http://localhost:11434/")).toBe("http://localhost:11434/v1");
		expect(normalizeLocalBaseUrl("https://jev.example.com/api/v1/")).toBe("https://jev.example.com/api/v1");
	});

	it("rejects empty and non-http values", () => {
		expect(normalizeLocalBaseUrl("   ")).toBeUndefined();
		expect(normalizeLocalBaseUrl("ftp://host/x")).toBeUndefined();
	});
});

describe("classifier-catalog: base URL notes", () => {
	it("explains where a prefilled value came from", () => {
		const options = buildClassifierProviders(source({ OLLAMA_HOST: "10.0.0.4:11434" }));
		const ollama = options.find((option) => option.provider === "ollama");
		const typesafe = options.find((option) => option.provider === "typesafe");
		expect(ollama).toBeDefined();
		expect(typesafe).toBeDefined();
		expect(classifierBaseUrlNote(ollama!, { OLLAMA_HOST: "10.0.0.4:11434" })).toBe("from OLLAMA_HOST");
		expect(classifierBaseUrlNote(ollama!, {})).toMatch(/set OLLAMA_HOST to override/);
		expect(classifierBaseUrlNote(typesafe!)).toMatch(/provider default/);
		expect(
			classifierBaseUrlNote({ provider: "typesafe", label: "t", models: [], local: false }),
		).toMatch(/resolved from pi's model catalog/);
	});
});
