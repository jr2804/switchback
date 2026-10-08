/**
 * Tests for the decision-model capability probe (`src/classifier-probe.ts`).
 *
 * The transport is injected, so the local-endpoint path never touches the
 * network; the answer validation and the report are pure and tested directly.
 */

import { describe, expect, it } from "vitest";
import type { ClassifierResult } from "@earendil-works/pi-ai";
import {
	buildProbeContext,
	formatProbeReport,
	missingProbeShapes,
	probeLocalClassifier,
	readProbeAnswers,
	summarizeProbe,
	PROBE_CHOICE_CRITERIA,
	PROBE_SCORE_CRITERIA,
} from "../src/classifier-probe.ts";
import type { FetchLike } from "../src/systemone.ts";

/** A result with the three answer shapes the probe expects. */
function result(answers: Record<string, unknown>, overrides: Partial<ClassifierResult> = {}): ClassifierResult {
	return {
		api: "typesafe-system-one",
		provider: "ollama",
		model: "tev1",
		answers,
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	} as unknown as ClassifierResult;
}

const GOOD = {
	choice: { type: "choice", choice: "sunny", probabilities: {}, confidence: 1 },
	// A `score` answer is a rubric index; the probe's rubric has three levels,
	// so a fair coin should land on the middle one (index 1).
	score: { type: "score", score: 1, confidence: 1 },
	noul: { type: "bool", probability: 0.97 },
};

describe("classifier-probe: the prompt", () => {
	it("asks one choice, one score and one bool question", () => {
		const context = buildProbeContext();
		expect(context.questions["choice"]?.type).toBe("choice");
		expect(context.questions["score"]?.type).toBe("score");
		expect(context.questions["noul"]?.type).toBe("bool");
		expect(Object.keys(context.questions)).toHaveLength(3);
		// A bare string: Respan rejects any object shape that is not
		// `{input, output}`, so the probe must not send `{purpose: ...}`.
		expect(typeof context.state).toBe("string");
		expect(String(context.state)).toMatch(/self-test/);
		// Three levels means the answer is an index in [0, 2] - a fair coin is an
		// even chance, i.e. the middle level.
		expect(PROBE_SCORE_CRITERIA).toHaveLength(3);
		const score = context.questions["score"];
		if (score?.type === "score") expect(score.criteria).toEqual([...PROBE_SCORE_CRITERIA]);
	});
});

describe("classifier-probe: answer validation", () => {
	it("accepts the three well-formed shapes", () => {
		expect(readProbeAnswers(result(GOOD))).toEqual({ choice: "sunny", score: 1, noul: true });
		expect(missingProbeShapes(readProbeAnswers(result(GOOD)))).toEqual([]);
	});

	it("rejects a choice outside the offered criteria", () => {
		const answers = readProbeAnswers(
			result({ ...GOOD, choice: { type: "choice", choice: "cloudy", probabilities: {}, confidence: 1 } }),
		);
		expect(answers.choice).toBeUndefined();
		expect(missingProbeShapes(answers)).toEqual(["choice"]);
		expect(Object.keys(PROBE_CHOICE_CRITERIA)).toContain("sunny");
	});

	it("rejects a score outside the rubric extent and a wrong answer type", () => {
		// The rubric has three levels, so index 3 is out of range even though it
		// would have passed the old (wrong) 0..100 range check.
		const outOfRange = readProbeAnswers(result({ ...GOOD, score: { type: "score", score: 3, confidence: 1 } }));
		expect(outOfRange.score).toBeUndefined();
		const negative = readProbeAnswers(result({ ...GOOD, score: { type: "score", score: -1, confidence: 1 } }));
		expect(negative.score).toBeUndefined();
		const wrongType = readProbeAnswers(result({ ...GOOD, noul: { type: "score", score: 1, confidence: 1 } }));
		expect(wrongType.noul).toBeUndefined();
		expect(missingProbeShapes(wrongType)).toEqual(["noul"]);
	});

	it("reports every shape as missing for an empty answer set", () => {
		const answers = readProbeAnswers(result({}));
		expect(missingProbeShapes(answers)).toEqual(["choice", "score", "noul"]);
	});
});

describe("classifier-probe: verdict and report", () => {
	it("passes only when all three shapes answered usably", () => {
		expect(summarizeProbe(result(GOOD), 120)).toMatchObject({ ok: true, ms: 120, missing: [] });
		expect(summarizeProbe(result({ choice: GOOD.choice }), 90)).toMatchObject({ ok: false, missing: ["score", "noul"] });
	});

	it("carries a transport error through", () => {
		const failed = summarizeProbe(result({}, { stopReason: "error", errorMessage: "System One API error (400)" }), 5);
		expect(failed.ok).toBe(false);
		expect(failed.error).toMatch(/400/);
		expect(formatProbeReport({ label: "ollama/tev1", result: failed })).toContain("System One API error (400)");
	});

	it("formats one line per shape", () => {
		const report = formatProbeReport({ label: "ollama/tev1 at http://localhost:11434/v1", result: summarizeProbe(result(GOOD), 250) });
		expect(report).toContain("ollama/tev1 at http://localhost:11434/v1");
		expect(report).toContain("choice  ✓ sunny");
		// The raw number is a rubric index, so the report names the level it lands on.
		expect(report).toContain("score   ✓ 1.00 (An even chance)");
		expect(report).toContain("noul    ✓ yes");
		expect(report).toContain("250 ms");
	});

	it("explains a partial answer set", () => {
		const report = formatProbeReport({ label: "ollama/tev1", result: summarizeProbe(result({ score: GOOD.score }), 30) });
		expect(report).toContain("choice  ✗ no usable answer");
		expect(report).toMatch(/may not be a System One decision model/);
	});
});

describe("classifier-probe: local endpoint path", () => {
	it("posts the three questions and reports the parsed answers", async () => {
		const captured: { url: string; body: string }[] = [];
		const fetch: FetchLike = async (url, init) => {
			captured.push({ url, body: init.body });
			// The wire shape: one typed answer object per question id, bool as `noul`.
			const body = {
				model: "tev1",
				answers: {
					choice: { type: "choice", choice: "sunny", probabilities: { sunny: 0.9, rainy: 0.1 }, confidence: 0.9 },
					score: { type: "score", score: 1.02, confidence: 0.8 },
					noul: { type: "noul", noul: 0.9 },
				},
				usage: { input: 1, output: 1 },
			};
			return { ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body };
		};
		const probe = await probeLocalClassifier({
			baseUrl: "http://localhost:11434/v1",
			apiKey: "ollama",
			provider: "ollama",
			id: "tev1",
			fetch,
		});
		expect(probe.ok).toBe(true);
		expect(probe.answers).toEqual({ choice: "sunny", score: 1.02, noul: true });
		expect(captured[0]?.url).toBe("http://localhost:11434/v1/systemone");
		const body = JSON.parse(captured[0]?.body ?? "{}") as { questions?: Record<string, unknown> };
		expect(Object.keys(body.questions ?? {}).sort()).toEqual(["choice", "noul", "score"]);
	});

	it("reports a failing endpoint without throwing", async () => {
		const fetch: FetchLike = async () => ({
			ok: false,
			status: 400,
			text: async () => JSON.stringify({ error: "does not support decision" }),
			json: async () => ({ error: "does not support decision" }),
		});
		const probe = await probeLocalClassifier({
			baseUrl: "http://localhost:11434/v1",
			apiKey: "ollama",
			provider: "ollama",
			id: "OOMU-SystemOne-0.6B",
			fetch,
		});
		expect(probe.ok).toBe(false);
		expect(probe.error).toMatch(/does not support decision/);
	});
});
