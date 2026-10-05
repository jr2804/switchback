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
 *      `scoreToResetAtMs` (bucket-relative, 31d cap). Timeout, parse error,
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
 * class (quota / auth / transient / overflow / unknown), reset (bucket
 * score 0-100), scope (model / account / ip / unknown). The prompt text is
 * the classifier's source of truth; switchback does not interpret the
 * message itself.
 *
 * `PROMPT_VERSION` is stamped on every classifier verdict recorded in
 * `crashes.json` so a future bump to v1.1 can invalidate stale verdicts.
 */

import type { ClassifierApi, ClassifierContext, ClassifierModel, ClassifierResult, StopReason } from "@earendil-works/pi-ai";
import { hashSample, lookupCrash } from "./crashes.ts";
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
 */
export const PROMPT_VERSION = "v1";

/** Clamp a reset timestamp to [now+1m, now+31d]. Inputs <= now are bumped to now+1m. */
function clampReset(at: number, now: number): number {
	if (!Number.isFinite(at)) return now + MAX_RESET_MS;
	if (at <= now) return now + 60_000;
	const delta = at - now;
	if (delta > MAX_RESET_MS) return now + MAX_RESET_MS;
	return at;
}

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
			transient: "Network failure, timeout, 5xx server error, or a 'try again' message indicating a recoverable infrastructure issue.",
			overflow: "Input context window exceeded: the request was too long for the model's context. May mention context, window, length, prompt, input too long.",
			unknown: "Anything that does not clearly fit the four categories above.",
		},
	},
	reset: {
		type: "score" as const,
		instructions:
			"If the error indicates when the model/provider becomes available again, return a score 0-100 representing how long to wait. Use the BUCKET-RELATIVE interpretation: in the hours bucket, score 51 = 1 hour; in the days bucket, score 76 = 1 day.",
		criteria: [
			"0 - no reset time is mentioned in the error message",
			"1-25 - reset time is on the order of seconds (score = seconds, capped at 25s)",
			"26-50 - reset time is on the order of minutes (score = minutes, capped at 25 min)",
			"51-75 - reset time is on the order of hours (score - 50 = hours, capped at 25h)",
			"76-100 - reset time is days or longer (score - 75 = days, capped at 25d)",
		] as string[],
	},
	scope: {
		type: "choice" as const,
		instructions:
			"When the error is quota or auth, is the limit/account scoped to the specific model, the whole account, or a single IP/region? Pick 'unknown' if not stated.",
		criteria: {
			model: "Only the named model is affected; other models on the same provider still work.",
			account: "The whole account is blocked, regardless of model.",
			ip: "A single IP or region is throttled; other regions or other accounts are unaffected.",
			unknown: "Scope is not stated in the error message.",
		},
	},
} as const;

const JEV_TIMEOUT_MS = 5_000;

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
 * Bucket-relative score-to-ms mapping. The JEV_QUESTIONS criteria give a
 * score 1-25 in each bucket; the score is the COUNT in the bucket (e.g. 51
 * = 1 hour, 52 = 2 hours, 75 = 25 hours, 76 = 1 day, 100 = 25 days).
 * Result is clamped to the 31-day monthly cap.
 */
function scoreToResetAtMs(score: unknown, now: number): number | undefined {
	if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) return undefined;
	let deltaMs: number;
	if (score <= 25) deltaMs = Math.max(1, score) * 1_000; // seconds
	else if (score <= 50) deltaMs = score * 60_000; // minutes (1 minute .. 25 minutes)
	else if (score <= 75) deltaMs = (score - 50) * 3_600_000; // hours (1h .. 25h)
	else deltaMs = (score - 75) * 86_400_000; // days (1d .. 25d)
	return clampReset(now + deltaMs, now);
}

/** Build a classified error from a classifier structured-output result. */
function fromJevResult(message: string, result: unknown, now: number): ClassifiedError | null {
	if (!result || typeof result !== "object") return null;
	const obj = result as Record<string, unknown>;
	const answers = obj["answers"];
	if (!answers || typeof answers !== "object") return null;
	const a = answers as Record<string, unknown>;
	const classAnswer = a["class"];
	const classChoice = typeof classAnswer === "object" && classAnswer !== null && "choice" in classAnswer
		? (classAnswer as Record<string, unknown>)["choice"]
		: undefined;
	const cls = normaliseClass(classChoice);
	const scopeAnswer = a["scope"];
	const scopeChoice = typeof scopeAnswer === "object" && scopeAnswer !== null && "choice" in scopeAnswer
		? (scopeAnswer as Record<string, unknown>)["choice"]
		: undefined;
	const scope = normaliseScope(scopeChoice);
	const resetAnswer = a["reset"];
	const resetScore = typeof resetAnswer === "object" && resetAnswer !== null && "score" in resetAnswer
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
export type NoClassifierReason =
	| "not-configured"
	| "unresolvable"
	| "timeout"
	| "threw"
	| "unparseable";

/**
 * The result of one classification attempt. `null` means "no classifier
 * decision available"; the caller should report and cycle.
 */
export type ClassificationResult =
	| { kind: "classified"; classified: ClassifiedError }
	| { kind: "no-classifier"; reason: NoClassifierReason };

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
			registry.classify(handle, {
				state: { prompt: message.slice(0, 16_000) },
				questions: JEV_QUESTIONS,
			}),
			new Promise<null>((resolve) => {
				timeoutHandle = setTimeout(() => resolve(null), JEV_TIMEOUT_MS);
			}),
		]);
		if (result === null) {
			return { kind: "no-classifier", reason: "timeout" };
		}
		const classified = fromJevResult(message, result, now);
		if (classified === null) {
			return { kind: "no-classifier", reason: "unparseable" };
		}
		return { kind: "classified", classified };
	} catch {
		return { kind: "no-classifier", reason: "threw" };
	} finally {
		if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
	}
}
