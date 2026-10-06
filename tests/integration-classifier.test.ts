/**
 * Live classifier integration test (opt-in).
 *
 * Runs switchback's real `classifyError` against a REAL SystemOne-style
 * classifier — the same transport pi uses (`llama-cpp-classify` for a local
 * llama-server, or `typesafe-system-one` for the TypeSafe cloud API). It is the
 * ground-truth validation promised by the coverage matrix: for each preserved
 * corpus scenario, does the classifier return the expected class?
 *
 * DISABLED BY DEFAULT. The whole suite is skipped unless the environment
 * variables below are set. Nothing is hardcoded — the endpoint, model and key
 * all come from the environment, so any deployment can be pointed at:
 *
 *   SWITCHBACK_CLASSIFIER_API       required; "llama-cpp-classify" | "typesafe-system-one"
 *   SWITCHBACK_CLASSIFIER_PROVIDER  required; provider id (e.g. "llama.cpp", "typesafe")
 *   SWITCHBACK_CLASSIFIER_MODEL     required; classifier model id
 *   SWITCHBACK_CLASSIFIER_BASE_URL  required; server root (llama.cpp) or API base URL
 *   SWITCHBACK_CLASSIFIER_API_KEY   optional; bearer token when the endpoint needs one
 *
 * Example (local llama.cpp, values supplied by the operator):
 *   $env:SWITCHBACK_CLASSIFIER_API="llama-cpp-classify"
 *   $env:SWITCHBACK_CLASSIFIER_PROVIDER="llama.cpp"
 *   $env:SWITCHBACK_CLASSIFIER_MODEL="<hf-tag-of-your-choice>"
 *   $env:SWITCHBACK_CLASSIFIER_BASE_URL="http://127.0.0.1:8080"
 *
 * The test drives the public `classifyError` entry point, so it exercises the
 * locked JEV_QUESTIONS prompt, the timeout/parse handling and the
 * score-to-reset mapping exactly as production does. The only shim is a
 * narrow `ClassifierRegistry` (findOfType + classify) that delegates to the
 * real transport; no message text is inspected anywhere.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { ClassifierApi, ClassifierModel, ProviderClassifier } from "@earendil-works/pi-ai";
import { classifyError, type ClassifierRegistry } from "../src/classify.ts";
import { systemOneClassifier } from "../src/systemone.ts";
import type { ErrorClass } from "../src/types.ts";

interface ClassifierEnv {
	api: ClassifierApi;
	provider: string;
	model: string;
	baseUrl: string;
	apiKey?: string;
}

function readClassifierEnv(): ClassifierEnv | undefined {
	const api = process.env["SWITCHBACK_CLASSIFIER_API"];
	const provider = process.env["SWITCHBACK_CLASSIFIER_PROVIDER"];
	const model = process.env["SWITCHBACK_CLASSIFIER_MODEL"];
	const baseUrl = process.env["SWITCHBACK_CLASSIFIER_BASE_URL"];
	if (!api || !provider || !model || !baseUrl) return undefined;
	const apiKey = process.env["SWITCHBACK_CLASSIFIER_API_KEY"];
	return { api, provider, model, baseUrl, ...(apiKey ? { apiKey } : {}) };
}

const env = readClassifierEnv();
const enabled = env !== undefined;

/**
 * Which classifier transport the live run exercises.
 *
 * Default "switchback": the transport that actually ships (src/systemone.ts).
 * "pi": pi-ai's own `typesafe-system-one` implementation, reachable from this
 * repo (which has node_modules) though NOT from an installed package. Set
 * SWITCHBACK_CLASSIFIER_TRANSPORT=pi to cross-check the two against each other.
 */
const transportKind = process.env["SWITCHBACK_CLASSIFIER_TRANSPORT"] ?? "switchback";

/** Resolve pi-ai's own transport (only usable inside this repo). */
async function resolvePiClassifier(api: ClassifierApi): Promise<ProviderClassifier> {
	switch (api) {
		case "llama-cpp-classify":
			return (await import("@earendil-works/pi-ai/api/llama-cpp-classify.lazy")).llamaCppClassifyApi();
		case "typesafe-system-one":
			return (await import("@earendil-works/pi-ai/api/typesafe-system-one.lazy")).typesafeSystemOneApi();
		default:
			throw new Error(
				`unsupported SWITCHBACK_CLASSIFIER_API "${api}" (expected "llama-cpp-classify" or "typesafe-system-one")`,
			);
	}
}

/** The transport under test: switchback's own by default, pi's on request. */
async function resolveClassifier(config: ClassifierEnv): Promise<ProviderClassifier> {
	if (transportKind === "pi") return resolvePiClassifier(config.api);
	if (!config.baseUrl) {
		throw new Error("SWITCHBACK_CLASSIFIER_TRANSPORT=switchback requires SWITCHBACK_CLASSIFIER_BASE_URL");
	}
	return systemOneClassifier(config.baseUrl, { ...(config.apiKey ? { apiKey: config.apiKey } : {}) });
}

function buildModel(config: ClassifierEnv): ClassifierModel<ClassifierApi> {
	return {
		type: "classifier",
		id: config.model,
		name: config.model,
		api: config.api,
		provider: config.provider,
		baseUrl: config.baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		contextWindow: 32_768,
	};
}

/** The narrow registry slice classifyError needs, backed by the real transport. */
function buildRegistry(model: ClassifierModel<ClassifierApi>, classifier: ProviderClassifier): ClassifierRegistry {
	const apiKey = env?.apiKey;
	return {
		findOfType(type, provider, id) {
			return type === "classifier" && provider === model.provider && id === model.id ? model : undefined;
		},
		classify(handle, context) {
			return classifier.classify(handle, context, apiKey !== undefined ? { apiKey } : undefined);
		},
	};
}

interface CorpusCase {
	scenario: string;
	expected: ErrorClass;
}

/**
 * Expected classes for the preserved corpus. `unknown-html` is intentionally
 * omitted: a bare 500 page is a genuine transient 5xx by the prompt's own
 * criteria, so its "unknown" scenario name would be a misleading expectation.
 */
const CORPUS: readonly CorpusCase[] = [
	{ scenario: "quota-5h-zai", expected: "quota" },
	{ scenario: "quota-weekly-ollama", expected: "quota" },
	{ scenario: "quota-monthly-opencode", expected: "quota" },
	{ scenario: "quota-minimax-token-plan", expected: "quota" },
	{ scenario: "auth-failure", expected: "auth" },
	{ scenario: "auth-account-suspended", expected: "auth" },
	{ scenario: "auth-zai-token-expired", expected: "auth" },
	{ scenario: "transient-5xx", expected: "transient" },
	{ scenario: "transient-timeout", expected: "transient" },
	{ scenario: "transient-overloaded", expected: "transient" },
];

const FIXTURE_PATH = fileURLToPath(new URL("../switchback.simulate.json", import.meta.url));

it("classifier integration is opt-in", () => {
	if (!enabled) {
		// eslint-disable-next-line no-console
		console.log(
			"[integration-classifier] SKIPPED: set SWITCHBACK_CLASSIFIER_API, _PROVIDER, _MODEL and _BASE_URL (optional _API_KEY) to run the live SystemOne validation.",
		);
	}
	// Documents the gate without asserting anything live.
	expect(typeof enabled).toBe("boolean");
});

describe.runIf(enabled)("classifier integration — live corpus validation", () => {
	let model: ClassifierModel<ClassifierApi>;
	let registry: ClassifierRegistry;
	let scenarios: Record<string, string>;
	let tempAgentDir: string;
	let originalAgentDir: string | undefined;

	beforeAll(async () => {
		if (!env) throw new Error("classifier integration env missing"); // unreachable when runIf(false)
		// Isolate the crash/annotation store so classifyError's Tier 2b lookup
		// never reads machine-local state.
		originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
		tempAgentDir = join(tmpdir(), `switchback-integrator-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tempAgentDir, { recursive: true });
		process.env["PI_CODING_AGENT_DIR"] = tempAgentDir;

		scenarios = (JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { scenarios: Record<string, string> }).scenarios;

		const classifier = await resolveClassifier(env);
		model = buildModel(env);
		registry = buildRegistry(model, classifier);

		// Warm-up: load the model server-side before the timed classifyError calls
		// (classifyError enforces a 10s classifier timeout; a cold start may exceed it).
		// Mirrors the real request shape - choice + score + bool - so the model and
		// its shared prompt prefix are resident before the first measured case.
		await classifier.classify(model, {
			state: { prompt: "warm-up" },
			questions: {
				class: {
					type: "choice",
					instructions: "Pick one.",
					criteria: { a: "first", b: "second", c: "third" },
				},
				reset: { type: "score", instructions: "Pick a level.", criteria: ["none", "soon", "later"] },
				ready: {
					type: "bool",
					instructions: "Does the state contain any keys?",
					criteria: { true: "the state has keys", false: "the state is empty" },
				},
			},
		}, env.apiKey !== undefined ? { apiKey: env.apiKey } : undefined);
	}, 300_000);

	afterAll(() => {
		if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
		if (tempAgentDir) rmSync(tempAgentDir, { recursive: true, force: true });
	});

	it.each(CORPUS)("$scenario classifies as $expected", { timeout: 120_000 }, async ({ scenario, expected }) => {
		const message = scenarios[scenario];
		expect(message, `fixture scenario "${scenario}" is missing`).toBeDefined();
		const result = await classifyError(message!, registry, { provider: env!.provider, id: env!.model }, Date.now());
		expect(
			result.kind,
			`classifier unavailable for "${scenario}" (${result.kind === "no-classifier" ? result.reason : ""})`,
		).toBe("classified");
		if (result.kind === "classified") {
			expect(result.classified.class, `"${scenario}" classified as ${result.classified.class}`).toBe(expected);
		}
	});
});
