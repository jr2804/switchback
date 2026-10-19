/**
 * System One classifier transport, delegated to the official SDK
 * (`@typesafe-ai/sdk`): URL building, auth, retries, backoff, abort and body
 * encoding are the package's; switchback only picks the endpoint, maps the
 * question/answer types it already shares with pi-ai, and keeps its own
 * fail-closed answer validation (the SDK types the reply but does not
 * runtime-validate it).
 *
 * Why not pi's own transport: `@earendil-works/pi-ai/api/typesafe-system-one.lazy`
 * resolves in this repository but NOT in a package installed by `pi install` -
 * pi supplies host packages to extensions by *bare specifier* only, so any deep
 * subpath fails with "Cannot find module". The type-only pi-ai imports below
 * are erased at load; the SDK is switchback-core's own real dependency and
 * resolves everywhere.
 *
 * URL conventions differ and are bridged in `toSdkBaseUrl`: switchback (and
 * pi, and OpenAI-compatible servers) carry the version segment in `baseUrl`
 * (`http://host:11434/v1` + `/systemone`), while the SDK takes an API root and
 * appends `/v1/systemone` itself.
 */

import { TypeSafeClient } from "@typesafe-ai/sdk";
import type { EntryType, Fetch, Questions } from "@typesafe-ai/sdk";
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

/** Per-attempt timeout handed to the SDK; classifyError wraps the call in its own race (see `CLASSIFIER_TIMEOUT_MS`). */
const REQUEST_TIMEOUT_MS = 30_000;

/** The fetch implementation the SDK uses; injectable for tests. Alias of the SDK's own `Fetch`. */
export type FetchLike = Fetch;

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

/**
 * Translate switchback's `baseUrl` (version segment included, pi/OpenAI
 * compatible convention) into the SDK's API root (version segment appended by
 * the SDK): `http://host:11434/v1` -> `http://host:11434`, so the SDK's
 * `/v1/systemone` lands on the same URL the old transport built.
 */
function toSdkBaseUrl(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return trimmed.endsWith("/v1") ? trimmed.slice(0, -"/v1".length) : trimmed;
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
				const client = new TypeSafeClient({
					apiKey,
					baseURL: toSdkBaseUrl(baseUrl),
					// Local SystemOne servers (Ollama, sham gateways) do not accept
					// `Content-Encoding: zstd`, which the SDK defaults to on Node >= 22.15.
					compression: false,
					...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
				});
				const reply = await client.systemOne(
					{
						model: model.id,
						state: context.state as unknown as NonNullable<EntryType>,
						questions: wireQuestions(context.questions) as unknown as Questions,
					},
					{
						signal: classifierOptions?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
						timeout: REQUEST_TIMEOUT_MS,
					},
				);
				result.answers = parseAnswers(label, reply.answers, context);
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
	/** The provider/id pair `findOfType` resolves - pass the config's `decisionModel` identity. */
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
