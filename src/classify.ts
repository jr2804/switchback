/**
 * Error classification.
 *
 * Classifier-only architecture. Per the design doc and the user's 2026-10-04
 * directive ("the only heuristic allowed is to cycle the model list on ANY
 * failure, without any classification"), every message-derived decision comes
 * from a single source: the configured SystemOne classifier (Jev, von, or
 * whatever `ctx.modelRegistry.findOfType("classifier", ...)` returns). When
 * the classifier is unavailable, none is resolvable, or its call fails, the
 * router reports the error visibly (`ctx.ui.notify` when `hasUI`) and cycles
 * to the next model in the config list without writing to the blocks store.
 *
 * Tier 2b annotation cache: BEFORE invoking the classifier, `classifyError`
 * checks `crashes.json` for an entry with the same raw-message sha256 that
 * carries a user `annotated` field. If so, the annotated class is returned
 * directly (source "annotation"; resetAtMs undefined -> default block). The
 * cache is ONLY a store of user-confirmed decisions. Entries with only a
 * classifier verdict (or only a no-classifier reason) never short-circuit -
 * the user must run `/switchback-annotate <hash> <class>` for the cache to
 * fire on those exact bytes. No code-side pattern/keyword derivation is
 * performed against the cache; the no-heuristics rule stands.
 *
 * Four branches in `classifyError`:
 *
 *   0. ANNOTATION CACHE: raw-message sha256 is in `crashes.json` with an
 *      `annotated` field. Return that class directly. Skips the classifier
 *      call.
 *
 *   1. STRUCTURED SIGNAL: `failed.message.stopReason === "length"`. This is
 *      pi's typed field, not a text inference. "length" is the canonical pi
 *      signal for a context-window overflow retry (pi already compacted; see
 *      docs/virtual-models.md). Returned as `class: "overflow"` immediately.
 *      Kept deliberately: the directive explicitly allows typed signals from
 *      pi, only the message-derived heuristics are forbidden.
 *
 *   2. CLASSIFIER: the configured `jev` entry via `ctx.modelRegistry.classify`.
 *      The structured-output answers (class / reset score / scope) are the
 *      ONLY message-derived decisions. Score is mapped to ms via
 *      `scoreToResetAtMs` (rubric index, 31d cap). Timeout, parse error,
 *      resolver-miss, or registry throw are all treated as "no classifier
 *      decision" and signal null to the caller.
 *
 *   3. NO-CLASSIFIER SIGNAL: classifier is missing, unresolvable, timed out,
 *      threw, or returned an unparseable result. `classifyError` returns
 *      a tagged `{ kind: "no-classifier", reason }` and the caller (routing)
 *      reports visibly and cycles. No class label is fabricated. No blocks
 *      write happens on this path. The cycle is the universal baseline; it
 *      fires on ANY failure when the classifier cannot decide.
 *
 * `JEV_QUESTIONS` are the four structured questions the classifier is asked:
 * class (quota / auth / transient / overflow / unknown), reset (a rubric
 * index - see RESET_RUBRIC), scope (model / account / ip / unknown). The prompt text is
 * the classifier's source of truth; switchback does not interpret the
 * message itself.
 *
 * `PROMPT_VERSION` is stamped on every classifier verdict recorded in
 * `crashes.json` so a future bump to v1.1 can invalidate stale verdicts.
 */

import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	StopReason,
} from "@earendil-works/pi-ai";
import { lookupCrash } from "./crashes.ts";
import { classifierState } from "./systemone.ts";
import type { ClassifiedError, ErrorClass, ErrorScope } from "./types.ts";

/** The classifier model entry that the registry returns for `findOfType("classifier", ...)`. */
type ClassifierEntry = ClassifierModel<ClassifierApi>;

/**
 * Minimum slice of `pi.modelRegistry` that `classifyError` needs. Keeping it
 * narrow lets a test supply a real classifier transport (llama.cpp / TypeSafe)
 * behind a small shim without constructing a full pi registry. The real
 * `ctx.modelRegistry` satisfies this structurally.
 */
export interface ClassifierRegistry {
	findOfType(type: "classifier", provider: string, id: string): ClassifierEntry | undefined;
	classify(model: ClassifierEntry, context: ClassifierContext): Promise<ClassifierResult>;
}

/** Hard cap on reset windows we are willing to record. Monthly windows top out at 31d. */
const MAX_RESET_MS = 31 * 24 * 3_600_000;

/**
 * The Jev prompt version. Bumped when `JEV_QUESTIONS` (or the locked prompt text
 * they encode) changes meaningfully. Stamped on every classifier verdict recorded
 * in `crashes.json` so a future bump can invalidate stale verdicts.
 *
 * v2 (2026-10-06): the `reset` question sends a rubric instead of a 0-100
 * scale. SystemOne's `score` answer is the probability-weighted average of the
 * rubric LEVEL INDICES (Ollama and TypeSafe agree; pi-ai forwards it verbatim),
 * so the old prompt could never return the value it asked for. Verified live
 * against `tev1:0.8b`: a five-criteria rubric plus the message "Try again in
 * 1d 2h" answers score 0.914 - an index, where v1 expected 78.
 *
 * v3 (2026-10-06): the reset rubric shrank from 21 levels to 9. TypeSafe's
 * hosted Jev rejects more than ten score levels, and a rejected request returns
 * no answers at all - so on the catalog path every message classified as
 * `unknown` (verified live: `400 {"detail":"Too many score levels. Must have at
 * most 10 levels."}`). Ollama allows 26; the tighter backend sets the ceiling.
 *
 * v4 (2026-10-06): the `scope` question now anchors each option in wording the
 * message actually contains. v3 asked the model to judge counterfactuals ("other
 * models still work") and named only `unknown` in its instructions, so `unknown`
 * took the prior mass and won on every case measured - `typesafe/jev-latest`
 * answered `unknown` at 84-92% with `account` second. The new text gives the
 * model the lexical cues an error message really carries (a named model, a key
 * or plan, an address) and asks for `unknown` only as a last resort. Verdicts
 * recorded under v1-v3 keep their old meaning.
 */
export const PROMPT_VERSION = "v4";

/** Clamp a reset timestamp to [now+1m, now+31d]. Inputs <= now are bumped to now+1m. */
function clampReset(at: number, now: number): number {
	if (!Number.isFinite(at)) return now + MAX_RESET_MS;
	if (at <= now) return now + 60_000;
	const delta = at - now;
	if (delta > MAX_RESET_MS) return now + MAX_RESET_MS;
	return at;
}

/**
 * Hard ceiling on how many levels a `score` question may carry.
 *
 * The two SystemOne backends disagree, and the tighter one wins: Ollama's
 * `SystemOneScoreQuestion.criteria.maxItems` is 26, but TypeSafe's hosted Jev
 * rejects more than ten. Verified live 2026-10-06 - a 21-level rubric to
 * `https://api.typesafe.ai/v1/systemone` answers
 * `400 {"detail":"Too many score levels. Must have at most 10 levels."}`, and a
 * rejected request yields no answers at all, so every message classifies as
 * `unknown`. Keep the rubric at or below this.
 */
export const MAX_SCORE_LEVELS = 10;

/**
 * The reset rubric. A SystemOne `score` question answers with the
 * probability-weighted average of the rubric LEVEL INDICES, so the levels are
 * the answer space: index 0 means "no reset time stated", and every later index
 * is a concrete wait. Switchback reads the index back into a duration, which
 * makes this table the single source of truth for reset windows - there is no
 * arithmetic against the raw score anywhere.
 *
 * The steps are roughly logarithmic (30s ... a month) so one rubric covers the
 * useful range without asking the model to choose among near-identical levels.
 * Nine levels, inside `MAX_SCORE_LEVELS` so both backends accept it. Measured
 * against a local `tev1:0.8b` on four real messages, this ladder and a 21-level
 * one scored within noise of each other (5.78 vs 5.59 bits mean log error), and
 * a coarse five-bucket variant was markedly worse (11.32) - so the resolution
 * below the ten-level ceiling buys nothing.
 */
const RESET_RUBRIC: readonly { readonly label: string; readonly ms: number }[] = [
	{ label: "no reset time is mentioned in the error message", ms: 0 },
	{ label: "within seconds", ms: 30_000 },
	{ label: "within minutes", ms: 15 * 60_000 },
	{ label: "about an hour", ms: 3_600_000 },
	{ label: "about 6 hours", ms: 6 * 3_600_000 },
	{ label: "about 1 day", ms: 86_400_000 },
	{ label: "about 3 days", ms: 3 * 86_400_000 },
	{ label: "about 1 week", ms: 7 * 86_400_000 },
	{ label: "about a month or longer", ms: 31 * 86_400_000 },
];

/**
 * Structured questions for the configured classifier.
 *
 * LOCKED 2026-10-04 against 41 passively-collected real error samples from
 *   z.ai GLM, Ollama Cloud Pro, MiniMax Plus, OpenCode-Go
 *   (mining path: ~/.pi/agent/sessions/*.jsonl).
 *
 * The locked corpus is used to anchor the prompt; the prompt's job is to
 * generalise from those samples to novel error messages the corpus did not
 * see. The corpus is NOT a code-side classifier - the four answers below
 * are the single source of truth.
 *
 * Re-validate when a new error shape arrives naturally. If the classifier
 * misclassifies a real sample, bump the prompt and add a note in the
 * coverage matrix; do not add a code-side heuristic to compensate.
 */
const JEV_QUESTIONS = {
	class: {
		type: "choice" as const,
		instructions:
			"Classify the failure of this AI provider API call into exactly one of: quota (rejected for a token/rate/usage budget), auth (credentials invalid, account suspended, or payment required), transient (network/timeout/5xx, retry may succeed), overflow (input context window exceeded; the request was too long), or unknown (anything else).",
		criteria: {
			quota: "Rejection for hitting a 5h/daily/weekly/monthly token, request-rate, or capacity budget. May mention quota, usage, rate limit, exhausted, exceeded, 429.",
			auth: "Rejection for invalid credentials, missing key, account suspended/disabled, payment required, 401/403.",
			transient:
				"Network failure, timeout, 5xx server error, or a 'try again' message indicating a recoverable infrastructure issue.",
			overflow:
				"Input context window exceeded: the request was too long for the model's context. May mention context, window, length, prompt, input too long.",
			unknown: "Anything that does not clearly fit the four categories above.",
		},
	},
	reset: {
		type: "score" as const,
		instructions:
			"If the error message states when the model or provider becomes available again, place that wait on the rubric: pick the level whose duration matches the reset time stated in the message. An explicit duration written in the message outranks any inference. If the message states no reset time, pick the first level.",
		criteria: RESET_RUBRIC.map((level) => level.label),
	},
	scope: {
		type: "choice" as const,
		instructions:
			"Decide what the limit attaches to, using the wording of the message itself. A named model or series (GLM, claude-*, gpt-*, a specific model id) means 'model'; a key, plan, balance, credits or a usage quota means 'account'; an address or region means 'ip'. Choose 'unknown' only when the message names none of those.",
		criteria: {
			model: "The message names a specific model or series (e.g. 'GLM 5h window', 'model x is rate limited').",
			account:
				"The message refers to the key, plan, balance, credits or a usage quota (e.g. 'invalid API key', 'weekly token limit exhausted', 'insufficient credits', 'monthly cap').",
			ip: "The message mentions an IP address, a region, or per-address throttling.",
			unknown: "The message names no model, no credential or plan, and no address - only a bare failure.",
		},
	},
} as const;

/**
 * Timeout for one classifier call.
 *
 * 10 s, not 5: a local SystemOne model that Ollama has evicted (its default
 * keep-alive is 5 min) has to be read back off disk before it can answer, and
 * a medium-sized one is slower at that than the request itself. Measured on
 * 2026-10-06 (Ollama v0.35.1): a 4.2B Q8_0 decision model cold-starts in ~7.8 s
 * against ~0.07 s warm, so a 5 s budget turned the first failure after an idle
 * gap into a spurious `no-classifier` blind cycle. Warm calls stay far inside
 * this budget, so the extra headroom costs nothing in the common case.
 */
export const CLASSIFIER_TIMEOUT_MS = 10_000;

function normaliseClass(value: unknown): ErrorClass {
	if (typeof value !== "string") return "unknown";
	const v = value.toLowerCase();
	if (v === "quota" || v === "auth" || v === "transient" || v === "overflow" || v === "unknown") return v;
	return "unknown";
}

function normaliseScope(value: unknown): ErrorScope {
	if (typeof value !== "string") return "unknown";
	const v = value.toLowerCase();
	if (v === "model" || v === "account" || v === "ip" || v === "unknown") return v;
	return "unknown";
}

/** Find a classifier in the model registry. The provider+id are looked up via JevConfig. */
function findJev(registry: ClassifierRegistry, jev: { provider: string; id: string }): ClassifierEntry | undefined {
	return registry.findOfType("classifier", jev.provider, jev.id);
}

/**
 * Map the classifier's `reset` answer to a timestamp.
 *
 * A SystemOne `score` answer is the probability-weighted average of the rubric
 * LEVEL INDICES (Ollama's `/v1/systemone` and TypeSafe's API both say so
 * explicitly; pi-ai forwards the number verbatim). The answer is therefore a
 * fractional INDEX into RESET_RUBRIC, never a percentage - verified live against
 * `tev1:0.8b`, where a five-level rubric plus "Try again in 1d 2h" answers 0.914.
 *
 * An index below 0.5 means the model's expectation sits nearer to "no reset
 * time" than to the shortest real wait: no reset. Between levels the value is
 * interpolated geometrically, matching the rubric's roughly logarithmic steps.
 * The result is clamped to the 31-day monthly cap.
 */
function scoreToResetAtMs(score: unknown, now: number): number | undefined {
	if (typeof score !== "number" || !Number.isFinite(score)) return undefined;
	if (score < 0.5) return undefined;
	const lastIndex = RESET_RUBRIC.length - 1;
	const clampToLevel = (index: number): number | undefined => {
		const ms = RESET_RUBRIC[index]?.ms;
		return ms === undefined || ms <= 0 ? undefined : clampReset(now + ms, now);
	};
	if (score >= lastIndex) return clampToLevel(lastIndex);
	const lower = Math.floor(score);
	if (lower < 1) return clampToLevel(1);
	const lowerMs = RESET_RUBRIC[lower]?.ms;
	const upperMs = RESET_RUBRIC[lower + 1]?.ms;
	if (lowerMs === undefined || upperMs === undefined || lowerMs <= 0) return clampToLevel(1);
	return clampReset(now + lowerMs * (upperMs / lowerMs) ** (score - lower), now);
}

/** Build a classified error from a classifier structured-output result. */
function fromJevResult(message: string, result: unknown, now: number): ClassifiedError | null {
	if (!result || typeof result !== "object") return null;
	const obj = result as Record<string, unknown>;
	const answers = obj["answers"];
	if (!answers || typeof answers !== "object") return null;
	const a = answers as Record<string, unknown>;
	const classAnswer = a["class"];
	const classChoice =
		typeof classAnswer === "object" && classAnswer !== null && "choice" in classAnswer
			? (classAnswer as Record<string, unknown>)["choice"]
			: undefined;
	const cls = normaliseClass(classChoice);
	const scopeAnswer = a["scope"];
	const scopeChoice =
		typeof scopeAnswer === "object" && scopeAnswer !== null && "choice" in scopeAnswer
			? (scopeAnswer as Record<string, unknown>)["choice"]
			: undefined;
	const scope = normaliseScope(scopeChoice);
	const resetAnswer = a["reset"];
	const resetScore =
		typeof resetAnswer === "object" && resetAnswer !== null && "score" in resetAnswer
			? (resetAnswer as Record<string, unknown>)["score"]
			: undefined;
	const resetAtMs = scoreToResetAtMs(resetScore, now);
	return {
		class: cls,
		scope,
		raw: message,
		source: "classifier",
		...(resetAtMs !== undefined ? { resetAtMs } : {}),
	};
}

/**
 * Reasons a classifier decision was unavailable. Surfaced to the caller and
 * the UI so the user knows the router is operating without classification.
 */
export type NoClassifierReason = "not-configured" | "unresolvable" | "timeout" | "threw" | "unparseable";

/**
 * The result of one classification attempt. `null` means "no classifier
 * decision available"; the caller should report and cycle.
 */
export type ClassificationResult =
	{ kind: "classified"; classified: ClassifiedError } | { kind: "no-classifier"; reason: NoClassifierReason };

/**
 * The result of one classifier call, before any interpretation.
 *
 * `answer` is the transport's raw `ClassifierResult`; `no-classifier` names why no
 * answer was obtained. Never a thrown error: every failure mode is a reason.
 */
export type ClassifierCallResult =
	{ kind: "answer"; result: ClassifierResult } | { kind: "no-classifier"; reason: NoClassifierReason };

/**
 * Resolve the configured classifier and ask it one set of questions.
 *
 * Shared by error classification and reasoning-level recommendation so both get
 * the same resolver, timeout and failure handling. A null race result means the
 * call exceeded `timeoutMs`; the timer is always cleared.
 */
export async function callClassifier(
	registry: ClassifierRegistry,
	jev: { provider: string; id: string } | undefined,
	context: ClassifierContext,
	timeoutMs: number = CLASSIFIER_TIMEOUT_MS,
): Promise<ClassifierCallResult> {
	if (jev === undefined) {
		return { kind: "no-classifier", reason: "not-configured" };
	}
	const handle = findJev(registry, jev);
	if (handle === undefined) {
		return { kind: "no-classifier", reason: "unresolvable" };
	}
	let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
	try {
		const result = await Promise.race([
			registry.classify(handle, context),
			new Promise<null>((resolve) => {
				timeoutHandle = setTimeout(() => resolve(null), timeoutMs);
			}),
		]);
		if (result === null) return { kind: "no-classifier", reason: "timeout" };
		return { kind: "answer", result };
	} catch {
		return { kind: "no-classifier", reason: "threw" };
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	}
}

/**
 * Read a `choice` answer out of a classifier result. Returns undefined when the
 * result carries no `answers` object, no answer for `questionId`, or an answer
 * that is not a choice - the transport is an external payload, so a malformed
 * result is a missing answer rather than an exception.
 */
export function readChoice(result: ClassifierResult, questionId: string): string | undefined {
	const answers: Record<string, ClassifierAnswer | undefined> | undefined = result.answers;
	if (answers === undefined) return undefined;
	const answer = answers[questionId];
	if (answer === undefined || answer.type !== "choice") return undefined;
	return answer.choice;
}

/**
 * The confidence a classifier reported for one answer, or undefined when the
 * result carries no usable confidence. Mirrors `readChoice`'s tolerance.
 */
export function readConfidence(result: ClassifierResult, questionId: string): number | undefined {
	const answers: Record<string, ClassifierAnswer | undefined> | undefined = result.answers;
	if (answers === undefined) return undefined;
	const answer = answers[questionId];
	if (answer === undefined) return undefined;
	const value = "confidence" in answer ? answer.confidence : undefined;
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Classify one failed request's error message.
 *
 * Returns a tagged `ClassificationResult` so the caller can distinguish a
 * real classifier verdict (`kind: "classified"`) from a no-classifier signal
 * (`kind: "no-classifier"`) without inferring from a class label.
 *
 * The "length" stopReason short-circuit is the ONLY message-independent
 * decision: it is pi's typed field, not text analysis.
 */
export async function classifyError(
	message: string,
	registry: ClassifierRegistry,
	jev: { provider: string; id: string } | undefined,
	now: number = Date.now(),
	stopReason?: StopReason,
): Promise<ClassificationResult> {
	// Branch 0: Tier 2b annotation cache. The raw-message sha256 lookup is the
	// ONLY key. An entry with a user `annotated` field short-circuits the
	// classifier call. resetAtMs is intentionally left undefined so the router
	// uses the default 5-minute block; the user can edit the annotation if a
	// longer window is wanted (a future /switchback-annotate <hash> <class>
	// --reset <duration> is the obvious extension).
	const cached = lookupCrash(message);
	if (cached?.annotated) {
		return {
			kind: "classified",
			classified: {
				class: cached.annotated.class,
				scope: "unknown",
				raw: message,
				source: "annotation",
			},
		};
	}

	// Branch 1: structured signal. Pi's typed stopReason is the only allowed
	// message-independent path; everything else is classifier-only.
	if (stopReason === "length") {
		return {
			kind: "classified",
			classified: { class: "overflow", scope: "model", raw: message, source: "structured" },
		};
	}

	// Branch 2: classifier. Any failure (not configured, unresolvable,
	// timeout, threw, unparseable) falls through to "no-classifier".
	const call = await callClassifier(registry, jev, {
		state: classifierState(message),
		questions: JEV_QUESTIONS,
	});
	if (call.kind === "no-classifier") {
		return call;
	}
	const classified = fromJevResult(message, call.result, now);
	if (classified === null) {
		return { kind: "no-classifier", reason: "unparseable" };
	}
	return { kind: "classified", classified };
}
