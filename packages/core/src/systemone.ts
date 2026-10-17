/**
 * Minimal System One classifier transport.
 *
 * Why this exists instead of importing pi's own transport:
 * `@earendil-works/pi-ai/api/typesafe-system-one.lazy` resolves in this
 * repository (it has its own node_modules) but NOT in a package installed by
 * `pi install`. Pi supplies host packages to extensions by *bare specifier*
 * only, so `import ... from "@earendil-works/pi-ai"` works while any deep
 * subpath fails with "Cannot find module". The type-only imports below are
 * erased at load, so they are safe; a value import is not.
 *
 * The wire protocol is small and stable (Ollama v0.35+ and TypeSafe both serve
 * it): POST `${baseUrl}/systemone` with `{ model, state, questions }`, read
 * `{ answers }`. `bool` questions travel as the wire-level `noul` type.
 *
 * This is switchback's own adapter for its own opt-in local-classifier
 * endpoint. It deliberately does not reimplement pi's retry/usage-costing
 * layers: a local server needs neither, and classifyError already applies its
 * own timeout and treats a transport error as "no classifier".
 */

import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierQuestion,
	ClassifierResult,
	JsonObject,
	ProviderClassifier,
} from "@earendil-works/pi-ai";

import type { ClassifierPort, HostModel } from "./ports.ts";

/** The only classifier wire API switchback drives. */
export const SYSTEM_ONE_API: ClassifierApi = "typesafe-system-one";

/**
 * The `state` to send with a SystemOne request.
 *
 * The wire protocol accepts a string, an object or an array; the bare text is
 * the shape every backend takes. Switchback used to send `{ prompt: <text> }`,
 * which Respan rejects with `400 Respan state must be a string or an object
 * with only input (a message array) and output (a message)` while Ollama and
 * TypeSafe accept it - so the breakage only ever showed up on Respan.
 *
 * pi-ai types `ClassifierContext.state` as `JsonObject`, narrower than the
 * protocol, so the string passes through this single helper rather than being
 * cast at each call site.
 */
export function classifierState(text: string): ClassifierContext["state"] {
	return text.slice(0, 16_000) as unknown as ClassifierContext["state"];
}

/** Default request timeout. classifyError wraps the call in its own race (see `CLASSIFIER_TIMEOUT_MS`). */
const REQUEST_TIMEOUT_MS = 30_000;

/** The subset of `fetch` this transport uses, injectable for tests. */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
	ok: boolean;
	status: number;
	text(): Promise<string>;
	json(): Promise<unknown>;
}>;

export interface SystemOneOptions {
	/** Bearer token. Local servers ignore it, but the header is always sent. */
	apiKey?: string;
	/** Override the ambient fetch (tests). */
	fetch?: FetchLike;
	/** Human label used in error messages. */
	label?: string;
}

/** `bool` is a public question type; the wire calls it `noul`. */
function wireQuestions(questions: Record<string, ClassifierQuestion>): Record<string, unknown> {
	return Object.fromEntries(
		Object.entries(questions).map(([id, question]) => [
			id,
			question.type === "bool" ? { ...question, type: "noul" } : question,
		]),
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function num(value: unknown, label: string, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error(`${label} returned an invalid ${field}`);
	}
	return value;
}

function probabilities(value: unknown, label: string, id: string): Record<string, number> {
	if (!isRecord(value)) throw new Error(`${label} returned invalid probabilities for ${id}`);
	return Object.fromEntries(
		Object.entries(value).map(([key, p]) => [key, num(p, label, `probability for ${id}.${key}`)]),
	);
}

/** Validate the raw answers against the questions we asked. */
function parseAnswers(label: string, value: unknown, context: ClassifierContext): Record<string, ClassifierAnswer> {
	if (!isRecord(value)) throw new Error(`${label} returned an unexpected response`);
	const parsed: Record<string, ClassifierAnswer> = {};
	for (const [id, question] of Object.entries(context.questions)) {
		const answer = value[id];
		if (!isRecord(answer)) throw new Error(`${label} did not return an answer for ${id}`);
		if (question.type === "choice") {
			if (answer["type"] !== "choice" || typeof answer["choice"] !== "string") {
				throw new Error(`${label} did not return a choice answer for ${id}`);
			}
			parsed[id] = {
				type: "choice",
				choice: answer["choice"],
				probabilities: probabilities(answer["probabilities"], label, id),
				confidence: num(answer["confidence"], label, `confidence for ${id}`),
			};
		} else if (question.type === "score") {
			if (answer["type"] !== "score") throw new Error(`${label} did not return a score answer for ${id}`);
			parsed[id] = {
				type: "score",
				score: num(answer["score"], label, `score for ${id}`),
				confidence: num(answer["confidence"], label, `confidence for ${id}`),
			};
		} else {
			if (answer["type"] !== "noul") throw new Error(`${label} did not return a bool answer for ${id}`);
			parsed[id] = { type: "bool", probability: num(answer["noul"], label, `probability for ${id}`) };
		}
	}
	return parsed;
}

/**
 * Build a `ProviderClassifier` for a System One endpoint. Never rejects: a
 * transport failure is reported as `stopReason: "error"` with an
 * `errorMessage`, which is how pi's own classifier behaves and what
 * `classifyError` turns into a no-classifier outcome.
 */
export function systemOneClassifier(baseUrl: string, options: SystemOneOptions = {}): ProviderClassifier {
	const label = options.label ?? "System One";
	const url = `${baseUrl.replace(/\/+$/, "")}/systemone`;
	return {
		async classify(
			model: ClassifierModel<ClassifierApi>,
			context: ClassifierContext,
			classifierOptions?: { apiKey?: string; signal?: AbortSignal },
		): Promise<ClassifierResult> {
			const result: ClassifierResult = {
				api: model.api,
				provider: model.provider,
				model: model.id,
				answers: {},
				stopReason: "stop",
				timestamp: Date.now(),
			};
			try {
				const apiKey = classifierOptions?.apiKey ?? options.apiKey;
				if (!apiKey) throw new Error(`No API key for provider: ${model.provider}`);
				const doFetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike);
				const signal = classifierOptions?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS);
				const response = await doFetch(url, {
					method: "POST",
					headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
					body: JSON.stringify({
						model: model.id,
						state: context.state,
						questions: wireQuestions(context.questions),
					}),
					signal,
				});
				const bodyText = response.ok ? "" : await response.text();
				if (!response.ok)
					throw new Error(`${label} returned ${response.status}${bodyText ? `: ${bodyText}` : ""}`);
				const body: unknown = await response.json();
				if (!isRecord(body)) throw new Error(`${label} returned an unexpected response`);
				result.answers = parseAnswers(label, body["answers"], context);
				return result;
			} catch (error) {
				result.stopReason = classifierOptions?.signal?.aborted ? "aborted" : "error";
				result.errorMessage = `${label} error: ${error instanceof Error ? error.message : String(error)}`;
				return result;
			}
		},
	};
}

/**
 * The `ClassifierPort` for hosts with no classifier catalog of their own
 * (OpenCode), wrapping `systemOneClassifier` behind the shape in `./ports.ts`.
 * The pi-ai `ClassifierModel` literal lives here and only as a type, so host
 * adapters satisfy the ClassifierPort without touching pi-ai values.
 */
export interface SystemOneClassifierPortOptions {
	/** Base URL of the System One endpoint; `undefined` matches "not configured". */
	baseUrl: string | undefined;
	/** The provider/id pair `findOfType` resolves - pass the config's `jev` identity. */
	identity: { provider: string; id: string };
	/** Bearer token for the endpoint. */
	apiKey?: string;
	/** Human label used in error messages. */
	label?: string;
	/** Override the ambient fetch (tests). */
	fetch?: FetchLike;
}

/**
 * Build the port. A missing `baseUrl` resolves nothing: `classify.ts` reads an
 * unresolvable handle as the `unresolvable` no-classifier reason, the visible
 * blind cycle, instead of a silent no-op.
 */
export function systemOneClassifierPort(options: SystemOneClassifierPortOptions): ClassifierPort {
	if (options.baseUrl === undefined) {
		return {
			findOfType: () => undefined,
			// Unreachable: classify.ts never calls classify without a resolved handle.
			classify: () => {
				throw new Error("systemOneClassifierPort called without a configured baseUrl");
			},
		};
	}
	const baseUrl = options.baseUrl;
	const handle: HostModel = {
		provider: options.identity.provider,
		id: options.identity.id,
		name: options.label ?? `System One (${options.identity.id})`,
		api: SYSTEM_ONE_API,
		// The endpoint's context window is meaningless for a classifier handle;
		// zero records that instead of inventing a number.
		contextWindow: 0,
	};
	const transport = systemOneClassifier(baseUrl, {
		...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
		...(options.label !== undefined ? { label: options.label } : {}),
		...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
	});
	return {
		findOfType: (_type, provider, id) => (provider === handle.provider && id === handle.id ? handle : undefined),
		classify: (model, context) =>
			transport.classify(
				{
					type: "classifier",
					id: model.id,
					name: handle.name,
					api: handle.api,
					provider: model.provider,
					baseUrl,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 0,
				},
				context,
			),
	};
}

/** State shapes accepted by `ClassifierContext`. */
export type { JsonObject };
