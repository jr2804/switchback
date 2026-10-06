/**
 * One-shot classifier self-test for a configured decision model.
 *
 * Most SystemOne endpoints publish no model list, so the model id has to be
 * guessed - which makes "did I configure a model that actually speaks System
 * One?" the one question a user cannot answer from the config alone. A wrong id,
 * a model without the `decision` capability, or an endpoint that is not a
 * SystemOne server at all fails only at classification time, i.e. exactly when
 * the router needs a verdict.
 *
 * This probe answers that up front: ONE prompt carrying all three answer shapes
 * a decision model must produce - a `choice`, a `score` and a `bool` (System
 * One's "noul") - and a verdict per shape. It is deliberately tiny and
 * deterministic (a coin flip and two-plus-two), so the answers can be checked
 * rather than judged: a choice outside the offered criteria, a score outside
 * the rubric, or a missing answer is a failure, not a matter of taste.
 *
 * The score question carries three levels and a fair coin is an even chance, so
 * the answer must land on the middle level - index 1. That is the checkable
 * part: a `score` answer is the probability-weighted average of the LEVEL
 * INDICES, not a percentage, so "1" is the pass and "50" would be a failure.
 *
 * The same code serves both classifier paths: a catalog classifier is called
 * through pi's registry, a local endpoint through switchback's own transport.
 */

import type {
	ClassifierAnswer,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
} from "@earendil-works/pi-ai";
import { SYSTEM_ONE_API, systemOneClassifier, type FetchLike } from "./systemone.ts";

/** Default budget for the whole probe (one round-trip). */
export const PROBE_TIMEOUT_MS = 30_000;

/** The choice options offered to the model; an answer outside them is a failure. */
export const PROBE_CHOICE_CRITERIA: Readonly<Record<string, string>> = {
	sunny: "A clear, bright day with blue skies.",
	rainy: "Overcast with steady rain.",
};

/**
 * The score rubric: three ordered levels, so the answer is an index in [0, 2].
 * A fair coin is an even chance, i.e. the middle level, index 1.
 */
export const PROBE_SCORE_CRITERIA: readonly string[] = ["Impossible", "An even chance", "Certain"];

/**
 * The probe prompt: three questions in one request, one per answer shape. The
 * state says what this is, so a decision model does not have to infer intent
 * from the question text alone.
 */
export function buildProbeContext(): ClassifierContext {
	return {
		state: {
			purpose: "switchback decision-model self-test",
			note: "Answer all three questions. This is a capability check, not a task.",
		},
		questions: {
			choice: {
				type: "choice",
				instructions: "Which option best describes a sunny day?",
				criteria: { ...PROBE_CHOICE_CRITERIA },
			},
			score: {
				type: "score",
				instructions: "How likely is it that a fair coin lands on heads?",
				criteria: [...PROBE_SCORE_CRITERIA],
			},
			noul: {
				type: "bool",
				instructions: "Is two plus two equal to four?",
				criteria: { true: "Yes, two plus two is four.", false: "No, two plus two is not four." },
			},
		},
	};
}

/** The three answers the probe looks for, each already validated. */
export interface ProbeAnswers {
	choice?: string;
	score?: number;
	noul?: boolean;
}

function answerOf(result: ClassifierResult, id: string): ClassifierAnswer | undefined {
	return result.answers[id];
}

/**
 * Read and validate the three answers. A shape that is absent, of the wrong
 * type, or outside its valid range is left undefined and reported as missing -
 * the probe checks capability, so "answered but nonsensically" counts as a
 * failure.
 */
export function readProbeAnswers(result: ClassifierResult): ProbeAnswers {
	const answers: ProbeAnswers = {};
	const choice = answerOf(result, "choice");
	if (choice?.type === "choice" && choice.choice in PROBE_CHOICE_CRITERIA) answers.choice = choice.choice;
	const score = answerOf(result, "score");
	// A `score` answer is a rubric index, so validity is the rubric's extent -
	// not 0..100. A value outside [0, criteria.length - 1] is a broken answer.
	if (
		score?.type === "score" &&
		Number.isFinite(score.score) &&
		score.score >= 0 &&
		score.score <= PROBE_SCORE_CRITERIA.length - 1
	) {
		answers.score = score.score;
	}
	const noul = answerOf(result, "noul");
	if (noul?.type === "bool" && Number.isFinite(noul.probability) && noul.probability >= 0 && noul.probability <= 1) {
		answers.noul = noul.probability >= 0.5;
	}
	return answers;
}

/** The three shapes the probe checks, in report order. */
export const PROBE_SHAPES: readonly ("choice" | "score" | "noul")[] = ["choice", "score", "noul"];

/** Which shapes did not come back usable. */
export function missingProbeShapes(answers: ProbeAnswers): ("choice" | "score" | "noul")[] {
	return PROBE_SHAPES.filter((shape) => answers[shape] === undefined);
}

/**
 * Render a `score` answer for the report. The raw number is a rubric index, so
 * it is shown rounded with the level it lands on - a bare "1.02" invites the
 * reader to mistake it for a percentage.
 */
function describeScore(score: number): string {
	const rounded = Math.round(score);
	const level = PROBE_SCORE_CRITERIA[rounded];
	return level === undefined ? score.toFixed(2) : `${score.toFixed(2)} (${level})`;
}

export interface ProbeResult {
	/** True when all three shapes answered usably. */
	ok: boolean;
	answers: ProbeAnswers;
	/** Shapes that failed, in report order. */
	missing: ("choice" | "score" | "noul")[];
	/** Round-trip time in milliseconds. */
	ms: number;
	/** Transport or provider error, when the call itself failed. */
	error?: string;
}

/** Build the verdict from a classifier result plus timing. */
export function summarizeProbe(result: ClassifierResult, ms: number): ProbeResult {
	const answers = readProbeAnswers(result);
	const missing = missingProbeShapes(answers);
	const error = result.stopReason === "error" ? result.errorMessage ?? "classifier reported an error" : undefined;
	return {
		ok: missing.length === 0 && error === undefined,
		answers,
		missing,
		ms,
		...(error !== undefined ? { error } : {}),
	};
}

/** Human-readable one-block report for `ui.notify`. */
export function formatProbeReport(opts: {
	label: string;
	result: ProbeResult;
}): string {
	const { label, result } = opts;
	const lines = [
		`switchback decision-model test: ${label} (${result.ms} ms)`,
		`  choice  ${result.answers.choice === undefined ? "✗ no usable answer" : `✓ ${result.answers.choice}`}`,
		`  score   ${result.answers.score === undefined ? "✗ no usable answer" : `✓ ${describeScore(result.answers.score)}`}`,
		`  noul    ${result.answers.noul === undefined ? "✗ no usable answer" : `✓ ${result.answers.noul ? "yes" : "no"}`}`,
	];
	if (result.error !== undefined) lines.push(`  error   ${result.error}`);
	if (!result.ok && result.error === undefined) {
		lines.push(
			`  the endpoint answered, but not in all three shapes - the model may not be a System One decision model`,
		);
	}
	return lines.join("\n");
}

/**
 * Probe a local SystemOne endpoint through switchback's own transport, so a
 * freshly configured `baseUrl` can be tested before pi is restarted (the
 * registered provider only appears at startup).
 */
export async function probeLocalClassifier(opts: {
	baseUrl: string;
	/** Bearer token; local servers ignore it but the transport requires one. */
	apiKey: string;
	provider: string;
	id: string;
	timeoutMs?: number;
	fetch?: FetchLike;
}): Promise<ProbeResult> {
	const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
	const classifier = systemOneClassifier(opts.baseUrl, {
		label: `${opts.provider}/${opts.id}`,
		...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
	});
	const model: ClassifierModel<ClassifierApi> = {
		type: "classifier",
		provider: opts.provider,
		id: opts.id,
		name: `${opts.id} (switchback probe)`,
		api: SYSTEM_ONE_API,
		baseUrl: opts.baseUrl,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 0,
	};
	const started = Date.now();
	const result = await classifier.classify(model, buildProbeContext(), {
		apiKey: opts.apiKey,
		signal: AbortSignal.timeout(timeoutMs),
	});
	return summarizeProbe(result, Date.now() - started);
}
