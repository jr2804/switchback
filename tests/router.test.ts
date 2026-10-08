/**
 * Integration tests for the switchback router.
 *
 * Classifier-only architecture (per the user's 2026-10-04 directive). All
 * message-derived decisions come from the configured SystemOne classifier; the
 * router has no other message-analysis surface. Tests in this file exercise:
 *
 *   - Routing structure: user / continuation / retry reasons, exhaustion, the
 *     blind-cycle fallback when no classifier is available.
 *   - Step 8 catalog validity: per-call availability, greyed entries, single-
 *     effective degraded mode, config-invalid for all-greyed lists.
 *   - Classifier path: with a mocked classifier that returns a structured
 *     answer, quota / auth / transient / overflow behave as documented.
 *   - Simulate mode: the fixture file is parsed, each scenario is runnable,
 *     and the simulator routes end-to-end. Fixture classification is NOT
 *     asserted here - the simulator reports whatever the classifier says; for
 *     no-classifier simulate runs, the cycle is the visible result.
 *   - State persistence: block / unblock / read with side effects on
 *     .pi/switchback.json.
 *
 * The real-sample corpus from prior captures lives in switchback.simulate.json
 * as FIXTURES. They are runnable via the simulate path but no longer used to
 * drive keyword assertions. A future Jev-live integration would point the
 * fake registry at a real Jev deployment and assert the same things; until
 * then, the classifier path is exercised through mocks that return the answer
 * the test is interested in.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	decide,
	buildRoute,
	observeUnretriedFailure,
	MAX_TRANSIENT_RETRIES,
	type Decision,
	type RouterRegistry,
} from "../src/routing.ts";
import { readCrashMap } from "../src/crashes.ts";
import { stateFilePath, readBlockedMap, isBlocked, unblockModel, blockModel, setPinnedModel } from "../src/state.ts";
import { simulateRetry, loadSimulate, getScenario, SimulateError } from "../src/simulate.ts";
import { findModelConfig, loadConfig } from "../src/config.ts";
import { callClassifier, classifyError, MAX_SCORE_LEVELS, type NoClassifierReason } from "../src/classify.ts";
import { ConfigInvalidError } from "../src/routing.ts";
import type { SwitchbackConfig } from "../src/types.ts";

interface FakeEntry {
	provider: string;
	id: string;
	/** Optional per-model thinking-level map, as the real catalog carries one. */
	thinkingLevelMap?: Record<string, string | null>;
	/** Per-entry context window; defaults to 128k so most tests are unaffected. */
	contextWindow?: number;
}

type ClassifyAnswer = {
	class: "quota" | "auth" | "transient" | "overflow" | "unknown";
	scope?: "model" | "account" | "ip" | "unknown";
	/** RESET_RUBRIC index, not a percentage (see scoreToResetAtMs). */
	resetScore?: number;
};

interface FakeRegistryOpts {
	entries: readonly FakeEntry[];
	/** Inspects the questions switchback sent, before the answer is produced. */
	onQuestions?: (questions: Record<string, unknown>) => void;
	/** When set, the registry's classify() returns this answer. When omitted, classify() resolves null. */
	answer?: ClassifyAnswer | null;
	/** When set, classify() rejects with this error. */
	throw?: Error;
	/** When set, classify() never resolves (simulates a timeout). */
	hang?: boolean;
	/** When set, classify() returns a non-null but unparseable result (no `answers` field). */
	unparseable?: boolean;
	/** Auth status overrides per provider id. */
	auth?: Record<string, boolean>;
	/**
	 * When set, the reasoning-level question is answered with this level. The
	 * router asks it when a decision activates a model (see src/thinking.ts).
	 */
	levelAnswer?: string;
	/**
	 * When set, the idle-reset question is answered with this choice. The router
	 * asks it for `idleReset: classifier` (see src/idle.ts).
	 */
	idleAnswer?: "return_to_initial" | "keep_current";
	/**
	 * When set, the context-candidate question is answered with this model id. The
	 * router asks it when several fitting candidates can hold the context
	 * (see src/context-fit.ts).
	 */
	candidateAnswer?: string;
}

function makeFakeRegistry(
	opts: FakeRegistryOpts,
): RouterRegistry & { classify: (...args: unknown[]) => Promise<unknown> } {
	const byKey = new Map<string, Model<Api>>();
	const providers = new Set<string>();
	for (const e of opts.entries) {
		byKey.set(`${e.provider}/${e.id}`, {
			provider: e.provider,
			id: e.id,
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			// Faithful to the real catalog entries this router targets: they are
			// reasoning models, so `clampThinkingLevel` has levels to choose from
			// instead of collapsing everything to "off".
			reasoning: true,
			...(e.thinkingLevelMap ? { thinkingLevelMap: e.thinkingLevelMap } : {}),
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			contextWindow: e.contextWindow ?? 128_000,
			maxTokens: 16_000,
		} as unknown as Model<Api>);
		providers.add(e.provider);
	}
	// A fake "classifier handle" — its presence (or absence) is what `findOfType`
	// returns. Tests that want the classifier path to be exercisable must set
	// answer / throw / hang / unparseable; tests that want the no-classifier path
	// leave those unset and findOfType returns undefined.
	const classifierConfigured =
		opts.answer !== undefined ||
		opts.throw !== undefined ||
		opts.hang === true ||
		opts.unparseable === true ||
		opts.levelAnswer !== undefined ||
		opts.idleAnswer !== undefined ||
		opts.candidateAnswer !== undefined;
	const fakeClassifierHandle = classifierConfigured
		? { provider: "typesafe", id: "jev-latest", api: "classifier" as const, input: ["text" as const] }
		: undefined;
	return {
		find(provider: string, modelId: string): Model<Api> | undefined {
			return byKey.get(`${provider}/${modelId}`);
		},
		findOfType(_type: string, provider: string, id: string): Model<Api> | undefined {
			if (fakeClassifierHandle === undefined) return undefined;
			if (provider === fakeClassifierHandle.provider && id === fakeClassifierHandle.id)
				return fakeClassifierHandle as unknown as Model<Api>;
			return undefined;
		},
		hasConfiguredAuth(): boolean {
			return true;
		},
		getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string } {
			const configured = opts.auth?.[provider] ?? providers.has(provider);
			return {
				configured,
				source: configured ? "environment" : undefined,
				label: configured ? "fake-credentials" : "no-credentials",
			};
		},
		classify: async (_model: unknown, context: unknown) => {
			const questions = (context as { questions?: Record<string, unknown> } | undefined)?.questions ?? {};
			// Lets a test inspect the prompt switchback actually sends.
			opts.onQuestions?.(questions);
			// The reasoning-level question is a separate prompt from the error
			// classification; answer it independently so both paths are testable.
			if ("level" in questions) {
				if (opts.levelAnswer === undefined) return null;
				return {
					stopReason: "stop" as const,
					answers: {
						level: { type: "choice" as const, choice: opts.levelAnswer, probabilities: {}, confidence: 1 },
					},
				};
			}
			// The idle-reset question is its own prompt (src/idle.ts), answered
			// independently so the sticky/preference paths stay testable.
			if ("idle_reset" in questions) {
				if (opts.idleAnswer === undefined) return null;
				return {
					stopReason: "stop" as const,
					answers: {
						idle_reset: {
							type: "choice" as const,
							choice: opts.idleAnswer,
							probabilities: {},
							confidence: 1,
						},
					},
				};
			}
			// The context-candidate question (src/context-fit.ts): which of the models
			// that can hold the conversation to switch to.
			if ("candidate" in questions) {
				if (opts.candidateAnswer === undefined) return null;
				return {
					stopReason: "stop" as const,
					answers: {
						candidate: {
							type: "choice" as const,
							choice: opts.candidateAnswer,
							probabilities: {},
							confidence: 1,
						},
					},
				};
			}
			if (opts.hang === true) return new Promise(() => {});
			if (opts.throw !== undefined) throw opts.throw;
			if (opts.unparseable === true) {
				// Non-null but missing the `answers` field — exercises the
				// unparseable-result branch in classifyError.
				return { stopReason: "stop" as const, not_answers: true };
			}
			if (opts.answer === undefined || opts.answer === null) return null;
			const answers: Record<string, unknown> = {
				class: { type: "choice" as const, choice: opts.answer.class, probabilities: {}, confidence: 1 },
				scope: {
					type: "choice" as const,
					choice: opts.answer.scope ?? "unknown",
					probabilities: {},
					confidence: 1,
				},
			};
			if (opts.answer.resetScore !== undefined) {
				answers["reset"] = { type: "score" as const, score: opts.answer.resetScore };
			}
			return { stopReason: "stop" as const, answers };
		},
	} as unknown as RouterRegistry & { classify: (...args: unknown[]) => Promise<unknown> };
}

let tmpDir: string;
let originalCwd: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
	originalCwd = process.cwd();
	originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
	tmpDir = join(tmpdir(), `switchback-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tmpDir, { recursive: true });
	// Isolate the runtime stores: decide() writes the account-scoped block map and
	// the crash store under <piConfigDir>/switchback. Without this, router tests
	// would pollute the real ~/.pi/agent store (switchback-5tb).
	process.env["PI_CODING_AGENT_DIR"] = tmpDir;
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	if (originalAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
	if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A real provider overload, captured 2026-10-05 during daily use. Kept verbatim:
 * the router must treat an overloaded cluster as transient, and consecutive failures
 * must walk forward through the fallback list instead of bouncing between the first
 * two entries.
 */
const OVERLOADED_529_MESSAGE =
	'Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"The server cluster is currently under high load. Please retry after a short wait and thank you for your patience. (2064) (529)"},"request_id":"0712991643802d84011aceea62a4c207"}';

const FALLBACKS: SwitchbackConfig = {
	id: "switchback/auto",
	name: "Auto (Switchback)",
	fallbacks: ["zai/glm-4.7", "ollama-cloud/pro", "minimax/plus", "opencode-go/pro"],
	jev: { provider: "typesafe", id: "jev-latest" },
};

/**
 * A real MiniMax quota message captured 2026-10-04 ("Token Plan usage limit
 * reached"). Kept verbatim as data; the classifier is mocked in this suite, so
 * the router never inspects the message text (no-heuristics rule).
 */
const MINIMAX_TOKEN_PLAN_MESSAGE =
	'Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Token Plan usage limit reached: Upgrade your Token Plan or purchase Credits for more usage. (2056)"},"request_id":"0711d862231417e81e99774da2dfb342"}';

function buildFakeRequest(overrides: {
	reason: "user" | "continuation" | "retry" | "direct";
	previous?: { provider: string; id: string };
	failed?: {
		provider: string;
		id: string;
		errorMessage: string;
		stopReason?: "error" | "length" | "aborted" | "stop" | "toolUse" | "deferred" | "pending";
	};
	stateCurrent?: string;
	transientRetries?: number;
	/** When true the branch has no router state yet (first request of a session). */
	noState?: boolean;
	/** Absolute timestamp for the single conversation message (idle-reset tests). */
	lastMessageAt?: number;
}) {
	const firstEntry = FALLBACKS.fallbacks[0]!.split("/");
	const firstModel = { provider: firstEntry[0]!, id: firstEntry[1]! };
	return {
		reason: overrides.reason,
		model: { ...firstModel, api: "openai-completions" },
		thinkingLevel: "medium" as const,
		...(overrides.previous
			? {
					previous: {
						model: {
							provider: overrides.previous.provider,
							id: overrides.previous.id,
							api: "openai-completions",
						},
						thinkingLevel: "medium" as const,
					},
				}
			: {}),
		...(overrides.failed
			? {
					failed: {
						model: {
							provider: overrides.failed.provider,
							id: overrides.failed.id,
							api: "openai-completions",
						},
						thinkingLevel: "medium" as const,
						message: {
							role: "assistant" as const,
							content: [],
							api: "openai-completions" as const,
							provider: overrides.failed.provider,
							model: overrides.failed.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: overrides.failed.stopReason ?? ("error" as const),
							errorMessage: overrides.failed.errorMessage,
							timestamp: Date.now(),
						},
					},
				}
			: {}),
		messages:
			overrides.lastMessageAt === undefined
				? []
				: [{ role: "user" as const, content: "hello", timestamp: overrides.lastMessageAt }],
		...(overrides.noState
			? {}
			: {
					state: {
						current: overrides.stateCurrent ?? FALLBACKS.fallbacks[0]!,
						transientRetries: overrides.transientRetries ?? 0,
					},
				}),
	};
}

describe("router — user reason", () => {
	it("picks the first non-blocked fallback", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
				{ provider: "minimax", id: "plus" },
				{ provider: "opencode-go", id: "pro" },
			],
		});
		const request = buildFakeRequest({ reason: "user" });
		const result = await decide("user", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		expect(result.decision.kind).toBe("stick");
		expect(result.decision.kind === "stick" ? result.decision.modelId : "").toBe("zai/glm-4.7");
	});

	it("skips a blocked preferred model", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const now = Date.now();
		const blocked = { "zai/glm-4.7": now + 60_000 };
		const request = buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro" });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked });
		expect(result.decision.kind).toBe("stick");
		expect(result.decision.kind === "stick" ? result.decision.modelId : "").toBe("ollama-cloud/pro");
	});
});

describe("router — session stickiness (user/direct)", () => {
	it("stays on the session's current model even when a preferred model is available", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const now = 1_000_000;
		const request = buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro" });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked: {} });
		expect(result.decision.kind).toBe("stick");
		expect(result.decision.kind === "stick" ? result.decision.modelId : "").toBe("ollama-cloud/pro");
		expect(result.decision.kind === "stick" ? result.decision.reason : "").toBe("session-sticky");
	});

	it("still sticks long after the switch (no return to the head of the list)", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		// Hours later: the old dwell implementation would have gone back to zai/glm-4.7.
		const now = 9_999_999;
		const request = buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro" });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked: {} });
		expect(result.decision.kind).toBe("stick");
		expect(result.decision.kind === "stick" ? result.decision.modelId : "").toBe("ollama-cloud/pro");
	});

	it("leaves a blocked current model and continues forward from its position", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
				{ provider: "minimax", id: "plus" },
			],
		});
		const now = 1_000_000;
		// Session sits on the SECOND entry; that one is now blocked, so the walk must
		// continue to the third, not restart at the head.
		const blocked = { "ollama-cloud/pro": now + 60_000 };
		const request = buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro" });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked });
		expect(result.decision.kind).toBe("switch");
		expect(result.decision.kind === "switch" ? result.decision.modelId : "").toBe("minimax/plus");
	});

	it("starts at the head of the list when the branch has no state", async () => {
		const registry = makeFakeRegistry({ entries: [{ provider: "zai", id: "glm-4.7" }] });
		const request = buildFakeRequest({ reason: "user", noState: true });
		const result = await decide("user", request, FALLBACKS, registry, { now: 1_000_000, blocked: {} });
		expect(result.decision.kind === "switch" ? result.decision.modelId : "").toBe("zai/glm-4.7");
	});
});

describe("router — continuation reason", () => {
	it("sticks to the previous model when in the fallback list and not blocked", async () => {
		const registry = makeFakeRegistry({ entries: [{ provider: "ollama-cloud", id: "pro" }] });
		const request = buildFakeRequest({
			reason: "continuation",
			previous: { provider: "ollama-cloud", id: "pro" },
		});
		const result = await decide("continuation", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		expect(result.decision.kind).toBe("stick");
		expect(result.decision.kind === "stick" ? result.decision.modelId : "").toBe("ollama-cloud/pro");
	});

	it("falls back to the first non-blocked when the previous model is blocked", async () => {
		const registry = makeFakeRegistry({ entries: [{ provider: "zai", id: "glm-4.7" }] });
		const now = Date.now();
		const blocked = { "ollama-cloud/pro": now + 60_000 };
		const request = buildFakeRequest({
			reason: "continuation",
			previous: { provider: "ollama-cloud", id: "pro" },
			stateCurrent: "ollama-cloud/pro",
		});
		const result = await decide("continuation", request, FALLBACKS, registry, { now, blocked });
		expect(result.decision.kind).toBe("switch");
		expect(result.decision.kind === "switch" ? result.decision.modelId : "").toBe("zai/glm-4.7");
	});
});

describe("router — retry reason: blind cycle (no classifier)", () => {
	const noClassifierReasons: NoClassifierReason[] = [
		"not-configured",
		"unresolvable",
		"timeout",
		"threw",
		"unparseable",
	];

	for (const reason of noClassifierReasons) {
		it(`cycles to the next effective model on no-classifier (${reason})`, { timeout: 15_000 }, async () => {
			const registry = makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
				],
				// No-classifier registry configuration per reason:
				//   not-configured: jev is undefined (handled in the model config below)
				//   unresolvable:   jev is configured but findOfType returns undefined
				//   timeout:        classify() never resolves
				//   threw:          classify() rejects
				//   unparseable:    classify() returns a non-null but unparseable result
				hang: reason === "timeout",
				throw: reason === "threw" ? new Error("simulated") : undefined,
				unparseable: reason === "unparseable",
			});
			// Per-reason jev config: "not-configured" is the only one where jev is absent
			// from the model config. The other four paths configure jev but fail at
			// different stages (unresolvable, timeout, threw, unparseable).
			const modelConfig: SwitchbackConfig = {
				...FALLBACKS,
				jev: reason === "not-configured" ? undefined : { provider: "typesafe", id: "jev-latest" },
			};
			const request = buildFakeRequest({
				reason: "retry",
				failed: { provider: "zai", id: "glm-4.7", errorMessage: "anything goes; no classification happens" },
			});
			const now = Date.now();
			const result = await decide("retry", request, modelConfig, registry, {
				now,
				blocked: {},
				notify: () => {},
			});
			expect(result.decision.kind).toBe("switch");
			if (result.decision.kind === "switch") {
				expect(result.decision.modelId).toBe("ollama-cloud/pro");
				expect(result.decision.reason.startsWith(`blind-cycle-${reason}`)).toBe(true);
			}
			expect(result.decision.kind).toBe("switch");
			if (result.decision.kind === "switch") {
				expect(result.decision.modelId).toBe("ollama-cloud/pro");
				expect(result.decision.reason.startsWith(`blind-cycle-${reason}`)).toBe(true);
			}
			// CRITICAL: blind cycle does NOT write to .pi/switchback.json.
			const blocked = readBlockedMap(now);
			expect(blocked["zai/glm-4.7"]).toBeUndefined();
		});
	}

	it("blind cycle surfaces notify with the reason", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
			// answer: null => classify() returns null => classifyError returns
			// no-classifier with reason "timeout" (in the test harness, a null
			// classifier result is treated as a timeout, not a successful null).
			answer: null,
		});
		const notifications: { message: string; type: "info" | "warning" | "error" }[] = [];
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "zai", id: "glm-4.7", errorMessage: "any message" },
		});
		await decide("retry", request, FALLBACKS, registry, {
			now: Date.now(),
			blocked: {},
			notify: (message, type) => notifications.push({ message, type }),
		});
		expect(notifications.length).toBe(1);
		expect(notifications[0]!.type).toBe("warning");
		expect(notifications[0]!.message).toMatch(/no classifier decision/);
		expect(notifications[0]!.message).toMatch(/timeout/);
	});

	it("blind cycle does NOT block and does NOT retry, even on repeated failures", async () => {
		// Even if the same model keeps failing, blind cycle just keeps moving to the
		// next one without writing a block. The cycle is the universal baseline.
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
			answer: null,
		});
		const path = stateFilePath();
		expect(existsSync(path)).toBe(false);
		for (const failedId of ["zai/glm-4.7", "ollama-cloud/pro"] as const) {
			const request = buildFakeRequest({
				reason: "retry",
				failed: {
					provider: failedId.split("/")[0]!,
					id: failedId.split("/")[1]!,
					errorMessage: "still nothing",
				},
			});
			await decide("retry", request, FALLBACKS, registry, { now: Date.now(), blocked: {}, notify: () => {} });
		}
		// Blind cycle writes nothing to the account-scoped block map.
		expect(existsSync(path)).toBe(false);
	});
});

describe("router — retry reason: classifier says quota", () => {
	for (const scenario of [
		// resetScore is a RESET_RUBRIC index (0..8), not a percentage: e.g. 4
		// is "about 6 hours", which is the closest level to a 5-hour window.
		{
			name: "z.ai 5h hit",
			message: "429 Too Many Requests: z.ai GLM 5h window exceeded. Resets at 2026-10-04T15:30:00Z.",
			resetScore: 4,
		},
		{
			name: "ollama-cloud weekly",
			message: "429: weekly token limit exhausted for ollama-cloud. Try again in 1d 2h.",
			resetScore: 5.1,
		},
		{
			name: "opencode-go monthly",
			message: "Rate limit reached: opencode-go monthly cap. Retry after 30s.",
			resetScore: 1,
		},
	]) {
		it(`blocks failed model and switches next: ${scenario.name}`, async () => {
			const registry = makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
					{ provider: "opencode-go", id: "pro" },
				],
				answer: { class: "quota", scope: "model", resetScore: scenario.resetScore },
			});
			const request = buildFakeRequest({
				reason: "retry",
				failed: { provider: "zai", id: "glm-4.7", errorMessage: scenario.message },
			});
			const now = Date.now();
			const result = await decide("retry", request, FALLBACKS, registry, { now, blocked: {} });
			expect(result.decision.kind).toBe("switch");
			if (result.decision.kind === "switch") {
				expect(result.decision.modelId).toBe("ollama-cloud/pro");
			}
			expect(result.nextState?.current).toBe("ollama-cloud/pro");
			const blocked = readBlockedMap(now);
			expect(blocked["zai/glm-4.7"]).toBeGreaterThan(now);
		});
	}

	it("blocks the failed minimax model and advances: Token Plan usage limit (real capture)", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "ollama-cloud", id: "pro" },
				{ provider: "minimax", id: "plus" },
			],
			// The captured message carries no reset time: the classifier reports quota
			// with no reset, so the router falls back to the default block duration.
			answer: { class: "quota", scope: "account" },
		});
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "minimax", id: "plus", errorMessage: MINIMAX_TOKEN_PLAN_MESSAGE },
		});
		const now = Date.now();
		const result = await decide("retry", request, FALLBACKS, registry, { now, blocked: {} });
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("ollama-cloud/pro");
		}
		const blocked = readBlockedMap(now);
		expect(isBlocked("minimax/plus", now, blocked)).toBe(true);
	});
});

describe("router — retry reason: classifier says transient", () => {
	it("sticks to the same model on first transient", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7" }],
			answer: { class: "transient" },
		});
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "zai", id: "glm-4.7", errorMessage: "any" },
			transientRetries: 0,
		});
		const result = await decide("retry", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		expect(result.decision.kind).toBe("stick");
		if (result.decision.kind === "stick") {
			expect(result.decision.modelId).toBe("zai/glm-4.7");
		}
		expect(result.nextState?.transientRetries).toBe(1);
	});

	it(`moves on after ${MAX_TRANSIENT_RETRIES} transient retries`, async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "ollama-cloud", id: "pro" }],
			answer: { class: "transient" },
		});
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "zai", id: "glm-4.7", errorMessage: "any" },
			transientRetries: MAX_TRANSIENT_RETRIES,
		});
		const result = await decide("retry", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("ollama-cloud/pro");
		}
	});
});

describe("router — retry reason: classifier says auth", () => {
	it("blocks the failed model and switches to the next", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "ollama-cloud", id: "pro" }],
			answer: { class: "auth", scope: "account" },
		});
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "zai", id: "glm-4.7", errorMessage: "any" },
		});
		const now = Date.now();
		const result = await decide("retry", request, FALLBACKS, registry, { now, blocked: {} });
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("ollama-cloud/pro");
		}
		const blocked = readBlockedMap(now);
		expect(isBlocked("zai/glm-4.7", now, blocked)).toBe(true);
	});

	it("classifier 'unknown' blocks with the documented behaviour (no heuristic inference)", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "ollama-cloud", id: "pro" }],
			answer: { class: "unknown" },
		});
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "zai", id: "glm-4.7", errorMessage: "any" },
		});
		const now = Date.now();
		const result = await decide("retry", request, FALLBACKS, registry, { now, blocked: {} });
		expect(result.decision.kind).toBe("switch");
		const blocked = readBlockedMap(now);
		expect(isBlocked("zai/glm-4.7", now, blocked)).toBe(true);
	});
});

describe("step 8 — catalog validity & degraded lists", () => {
	it("greyed-model-not-in-catalog: route skips the missing entry and picks next", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "ollama-cloud", id: "pro" }],
		});
		const request = buildFakeRequest({ reason: "user" });
		const result = await decide("user", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("ollama-cloud/pro");
		}
	});

	it("greyed-model-not-in-catalog does NOT write any block", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "ollama-cloud", id: "pro" }],
		});
		const request = buildFakeRequest({ reason: "user" });
		await decide("user", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		// The account-scoped block map (isolated to tmpDir) stays empty.
		expect(Object.keys(readBlockedMap()).length).toBe(0);
	});

	it("greyed-provider-unavailable: skip the entry when getProviderAuthStatus says not configured", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "ollama-cloud", id: "pro" }],
			auth: { zai: false },
		});
		const request = buildFakeRequest({ reason: "user" });
		const result = await decide("user", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("ollama-cloud/pro");
		}
	});

	it("single effective model: routes to it even when blocked (degraded mode)", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7" }],
		});
		const now = Date.now();
		const blocked = { "zai/glm-4.7": now + 60_000 };
		const request = buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro" });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked });
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("zai/glm-4.7");
			expect(result.decision.reason.startsWith("degraded")).toBe(true);
		}
		expect(result.nextState?.degradedWarned).toBe(true);
	});

	it("single effective model: degraded-warned fires once even after repeated routing", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7" }],
		});
		const now = Date.now();
		const blocked = { "zai/glm-4.7": now + 60_000 };
		const first = buildFakeRequest({ reason: "user" });
		const r1 = await decide("user", first, FALLBACKS, registry, { now, blocked });
		const second = buildFakeRequest({ reason: "user", stateCurrent: r1.nextState?.current });
		second.state = r1.nextState;
		const r2 = await decide("user", second, FALLBACKS, registry, { now: now + 1000, blocked });
		expect(r2.nextState?.degradedWarned).toBe(true);
	});

	it("all entries invalid: returns config-invalid, not opaque exhausted", async () => {
		const registry = makeFakeRegistry({ entries: [] });
		const request = buildFakeRequest({ reason: "user" });
		const result = await decide("user", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		expect(result.decision.kind).toBe("config-invalid");
		if (result.decision.kind === "config-invalid") {
			expect(result.decision.greyed.length).toBeGreaterThan(0);
			for (const g of result.decision.greyed) {
				expect(g.reason).toBe("model-not-in-catalog");
			}
		}
	});

	it("auto-recovery: per-call resolution, no caching", async () => {
		let registered = false;
		const dynamicRegistry = {
			find(provider: string, modelId: string): Model<Api> | undefined {
				if (registered && provider === "zai" && modelId === "glm-4.7") {
					return {
						provider: "zai",
						id: "glm-4.7",
						api: "openai-completions",
						baseUrl: "x",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						contextWindow: 128_000,
						maxTokens: 16_000,
					} as unknown as Model<Api>;
				}
				return undefined;
			},
			findOfType: () => undefined,
			hasConfiguredAuth: () => true,
			getProviderAuthStatus: () => ({ configured: true, label: "fake" }),
			classify: async () => null,
		} as unknown as Parameters<typeof decide>[3];

		const r1 = await decide("user", buildFakeRequest({ reason: "user" }), FALLBACKS, dynamicRegistry, {
			now: 1,
			blocked: {},
		});
		expect(r1.decision.kind).toBe("config-invalid");

		registered = true;
		const r2 = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "nonexistent/model" }),
			FALLBACKS,
			dynamicRegistry,
			{ now: 2, blocked: {} },
		);
		expect(r2.decision.kind).toBe("switch");
		if (r2.decision.kind === "switch") {
			expect(r2.decision.modelId).toBe("zai/glm-4.7");
		}
	});

	it("buildRoute throws ConfigInvalidError for config-invalid decision", async () => {
		const registry = makeFakeRegistry({ entries: [] });
		const request = buildFakeRequest({ reason: "user" });
		const result = await decide("user", request, FALLBACKS, registry, { now: Date.now(), blocked: {} });
		expect(result.decision.kind).toBe("config-invalid");
		expect(() => buildRoute(registry, result.decision, "medium", result.nextState)).toThrow();
	});

	it("resolveFallbacks: per-entry reason strings", async () => {
		const { resolveFallbacks } = await import("../src/availability.ts");
		const registry = makeFakeRegistry({
			entries: [{ provider: "ollama-cloud", id: "pro" }],
		});
		const resolved = resolveFallbacks(FALLBACKS.fallbacks, registry);
		expect(resolved.effectiveCount).toBe(1);
		expect(resolved.greyedCount).toBe(3);
		for (const entry of resolved.entries) {
			if (entry.availability !== "effective") {
				expect(entry.reason).toBe("model-not-in-catalog");
			}
		}
	});

	it("ConfigInvalidError carries greyed detail for callers", () => {
		const err = new ConfigInvalidError({
			kind: "config-invalid",
			reason: "all-configured-fallbacks-greyed",
			effective: [],
			greyed: [{ id: "zai/glm-4.7", reason: "model-not-in-catalog" }],
		});
		expect(err.name).toBe("ConfigInvalidError");
		expect(err.decision.greyed.length).toBe(1);
	});
});

describe("router — exhaustion", () => {
	it("returns exhausted when every effective fallback is blocked AND more than one effective exists", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
				{ provider: "minimax", id: "plus" },
				{ provider: "opencode-go", id: "pro" },
			],
		});
		const now = Date.now();
		const blocked = {
			"zai/glm-4.7": now + 60_000,
			"ollama-cloud/pro": now + 60_000,
			"minimax/plus": now + 60_000,
			"opencode-go/pro": now + 60_000,
		};
		const request = buildFakeRequest({ reason: "user" });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked });
		expect(result.decision.kind).toBe("exhausted");
	});
});

describe("simulate mode — end-to-end", () => {
	const fixturePath = join(process.cwd(), "switchback.simulate.json");

	it("loads the bundled fixture and resolves every scenario", () => {
		const cfg = loadSimulate(fixturePath);
		const expected = [
			"quota-5h-zai",
			"quota-weekly-ollama",
			"quota-monthly-opencode",
			"auth-failure",
			"transient-5xx",
			"transient-timeout",
			"unknown-html",
			"auth-account-suspended",
			"auth-zai-token-expired",
		];
		for (const name of expected) {
			expect(getScenario(cfg, name)).toBeDefined();
		}
	});

	it("rejects simulate mode when the fixture file is missing", () => {
		const missing = join(tmpDir, "no-such-fixture.json");
		expect(() => loadSimulate(missing)).toThrow(SimulateError);
	});

	it("returns undefined for an unknown scenario", () => {
		const cfg = loadSimulate(fixturePath);
		expect(getScenario(cfg, "this-scenario-does-not-exist")).toBeUndefined();
	});

	it("simulate path with a quota classifier cycles one step (the simulator injects a message; classification comes from the registered classifier)", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
			answer: { class: "quota", scope: "model", resetScore: 4 },
		});
		const cfg = loadSimulate(fixturePath);
		const message = getScenario(cfg, "quota-5h-zai")!;
		const result = await simulateRetry(message, FALLBACKS, registry, {}, Date.now());
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("ollama-cloud/pro");
		}
	});

	it("simulate path without a classifier: blind cycle (no block, surfaces notify)", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
			answer: null,
		});
		const notifications: { message: string; type: "info" | "warning" | "error" }[] = [];
		const cfg = loadSimulate(fixturePath);
		const message = getScenario(cfg, "auth-zai-token-expired")!;
		const result = await simulateRetry(
			message,
			FALLBACKS,
			registry,
			{ notify: (msg, type) => notifications.push({ message: msg, type }) },
			Date.now(),
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.reason.startsWith("blind-cycle-")).toBe(true);
		}
		expect(notifications.length).toBe(1);
	});
});

describe("F2 — context overflow (pi's typed stopReason)", () => {
	it("structured stopReason='length' short-circuits to overflow regardless of message text", async () => {
		// The message body has "exceeded" but the typed stopReason wins.
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const result = await classifyError(
			"Request exceeded the context window of 128k tokens.",
			registry,
			{ provider: "typesafe", id: "jev-latest" },
			Date.now(),
			"length",
		);
		expect(result.kind).toBe("classified");
		if (result.kind === "classified") {
			expect(result.classified.class).toBe("overflow");
		}
	});

	it("router sticks on overflow (no block, no switch)", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "zai", id: "glm-4.7", errorMessage: "any", stopReason: "length" },
		});
		const now = Date.now();
		const result = await decide("retry", request, FALLBACKS, registry, { now, blocked: {} });
		expect(result.decision.kind).toBe("stick");
		if (result.decision.kind === "stick") {
			expect(result.decision.modelId).toBe("zai/glm-4.7");
		}
		const blocked = readBlockedMap(now);
		expect(blocked["zai/glm-4.7"]).toBeUndefined();
	});
});

describe("classifyError — direct unit tests for the three branches", () => {
	it("branch 1: stopReason='length' returns classified overflow", async () => {
		const registry = makeFakeRegistry({ entries: [] });
		const result = await classifyError("anything", registry, undefined, Date.now(), "length");
		expect(result.kind).toBe("classified");
		if (result.kind === "classified") {
			expect(result.classified.class).toBe("overflow");
		}
	});

	it("branch 2: classifier resolves quota with reset score -> classified", async () => {
		const registry = makeFakeRegistry({
			entries: [],
			// A `score` answer is a rubric INDEX (0..8), not a percentage.
			// Index 4 = "about 6 hours".
			answer: { class: "quota", scope: "model", resetScore: 4 },
		});
		const now = 1_000_000_000;
		const result = await classifyError("any message", registry, { provider: "typesafe", id: "jev-latest" }, now);
		expect(result.kind).toBe("classified");
		if (result.kind === "classified") {
			expect(result.classified.class).toBe("quota");
			expect(result.classified.resetAtMs).toBe(now + 6 * 3_600_000);
		}
	});

	it("branch 2: classifier resolves unparseable -> no-classifier, unparseable reason", async () => {
		const registry = {
			findOfType: () => ({ provider: "typesafe", id: "jev-latest", api: "classifier" }),
			classify: async () => ({ not_an_answer: true }),
		};
		const result = await classifyError(
			"any",
			registry as unknown as Parameters<typeof classifyError>[1],
			{ provider: "typesafe", id: "jev-latest" },
			Date.now(),
		);
		expect(result.kind).toBe("no-classifier");
		if (result.kind === "no-classifier") {
			expect(result.reason).toBe("unparseable");
		}
	});

	it("branch 3: no jev config -> no-classifier, not-configured reason", async () => {
		const registry = makeFakeRegistry({ entries: [] });
		const result = await classifyError("any", registry, undefined, Date.now());
		expect(result.kind).toBe("no-classifier");
		if (result.kind === "no-classifier") {
			expect(result.reason).toBe("not-configured");
		}
	});

	it("branch 3: jev configured but unresolvable in registry -> no-classifier, unresolvable reason", async () => {
		const registry = makeFakeRegistry({ entries: [] }); // findOfType returns undefined
		const result = await classifyError("any", registry, { provider: "typesafe", id: "jev-latest" }, Date.now());
		expect(result.kind).toBe("no-classifier");
		if (result.kind === "no-classifier") {
			expect(result.reason).toBe("unresolvable");
		}
	});

	it("branch 3: classifier times out -> no-classifier, timeout reason", async () => {
		// An explicit short budget keeps this instant. The production value is
		// `CLASSIFIER_TIMEOUT_MS` (10 s, sized for a cold local model) and the race
		// that produces the `timeout` reason is `callClassifier`'s either way;
		// `classifyError` only forwards the tagged result (covered by the
		// `threw` / `unresolvable` cases above).
		const registry = makeFakeRegistry({ entries: [], hang: true });
		const result = await callClassifier(
			registry,
			{ provider: "typesafe", id: "jev-latest" },
			{ state: { prompt: "any" }, questions: {} },
			50,
		);
		expect(result.kind).toBe("no-classifier");
		if (result.kind === "no-classifier") {
			expect(result.reason).toBe("timeout");
		}
	});

	it("branch 3: classifier throws -> no-classifier, threw reason", async () => {
		const registry = makeFakeRegistry({ entries: [], throw: new Error("simulated") });
		const result = await classifyError("any", registry, { provider: "typesafe", id: "jev-latest" }, Date.now());
		expect(result.kind).toBe("no-classifier");
		if (result.kind === "no-classifier") {
			expect(result.reason).toBe("threw");
		}
	});

	it("scoreToResetAtMs reads the rubric index: 0 = none, 4 = 6h, last = 31d cap", async () => {
		// A SystemOne `score` answer is the probability-weighted average of the
		// rubric LEVEL INDICES, so the value indexes RESET_RUBRIC directly.
		// Verified live against tev1:0.8b (five levels, "in 1d 2h" -> 0.914).
		const now = 1_000_000_000;
		const registry = (score: number) =>
			makeFakeRegistry({ entries: [], answer: { class: "quota", scope: "model", resetScore: score } });
		const resetAt = async (score: number) => {
			const r = await classifyError("any", registry(score), { provider: "typesafe", id: "jev-latest" }, now);
			return r.kind === "classified" ? r.classified.resetAtMs : undefined;
		};
		// Index 0 ("no reset time") and anything nearer to it than to "within
		// seconds": no reset.
		expect(await resetAt(0)).toBeUndefined();
		expect(await resetAt(0.4)).toBeUndefined();
		// Index 1 = "within seconds" (30s at the level itself).
		expect(await resetAt(1)).toBe(now + 30_000);
		// Index 4 = "about 6 hours"; index 5 = "about 1 day".
		expect(await resetAt(4)).toBe(now + 6 * 3_600_000);
		expect(await resetAt(5)).toBe(now + 86_400_000);
		// Between two levels the value is interpolated geometrically: halfway
		// between 6h and 1d is 6h * sqrt(4) = 12h.
		expect(await resetAt(4.5)).toBeCloseTo(now + 12 * 3_600_000, -3);
		// Beyond the last level (index 8, "a month or longer") the 31-day cap applies.
		expect(await resetAt(8)).toBe(now + 31 * 86_400_000);
		expect(await resetAt(999)).toBe(now + 31 * 86_400_000);
	});

	it("keeps the reset rubric within the level ceiling both backends accept", async () => {
		// TypeSafe's hosted Jev rejects more than ten score levels with
		// `400 {"detail":"Too many score levels..."}`, and a rejected request
		// returns no answers - every message would classify as `unknown`. Ollama
		// allows 26; the tighter backend is the one that matters.
		let criteria: string[] | undefined;
		const registry = makeFakeRegistry({
			entries: [],
			answer: { class: "quota", scope: "model" },
			hang: false,
			onQuestions: (questions) => {
				const reset = questions["reset"];
				criteria = reset && "criteria" in reset ? (reset.criteria as string[]) : undefined;
			},
		});
		await classifyError("any", registry, { provider: "typesafe", id: "jev-latest" }, 1_000_000_000);
		expect(criteria).toBeDefined();
		expect(criteria!.length).toBeLessThanOrEqual(MAX_SCORE_LEVELS);
	});
});

describe("observeUnretriedFailure — failures pi will not retry", () => {
	// pi only hands a router an error when isRetryableAssistantError accepts its
	// text. A quota message that trips the non-retryable list (here on the word
	// "billing", present only in a help URL) never reaches route(), so switchback
	// saw nothing and the model was never blocked. This is the fallback.
	const OLLAMA_QUOTA =
		'429: {"message":"You reached your Pro 5-hour limit. Max is $100/month for $300 of usage, ' +
		'with no 5-hour or weekly caps: https://ollama.com/settings/billing (ref: abc)","type":"api_error"}';

	it("blocks the failed model, so the next user turn walks forward past it", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
			answer: { class: "quota", scope: "account", resetScore: 5 },
		});
		const now = Date.now();
		const acted = await observeUnretriedFailure({
			failedId: "zai/glm-4.7",
			errorMessage: OLLAMA_QUOTA,
			stopReason: "error",
			jev: FALLBACKS.jev,
			registry,
			now,
			blocked: readBlockedMap(now),
		});
		expect(acted).toBe(true);

		// The block is what makes the next turn leave the model behind: a blocked
		// current model is skipped by the `user` path, which is the whole point.
		const later = now + 1_000;
		expect(isBlocked("zai/glm-4.7", later, readBlockedMap(later))).toBe(true);
		const request = buildFakeRequest({ reason: "user", stateCurrent: "zai/glm-4.7" });
		const result = await decide("user", request, FALLBACKS, registry, {
			now: later,
			blocked: readBlockedMap(later),
		});
		expect(result.decision.kind).toBe("switch");
		expect(result.decision.kind === "switch" ? result.decision.modelId : "").toBe("ollama-cloud/pro");
	});

	it("records the verdict in the crash store", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7" }],
			answer: { class: "quota", scope: "account", resetScore: 5 },
		});
		const now = Date.now();
		await observeUnretriedFailure({
			failedId: "zai/glm-4.7",
			errorMessage: OLLAMA_QUOTA,
			stopReason: "error",
			jev: FALLBACKS.jev,
			registry,
			now,
			blocked: readBlockedMap(now),
		});
		const map = readCrashMap();
		const entry = Object.values(map).find((e) => e.provider === "zai" && e.model === "glm-4.7");
		expect(entry).toBeDefined();
		expect(entry?.verdict?.class).toBe("quota");
		expect(entry?.action).toBe("blocked+advanced");
	});

	it("does not block, and says so, when no classifier is configured", async () => {
		const registry = makeFakeRegistry({ entries: [{ provider: "zai", id: "glm-4.7" }] });
		const now = Date.now();
		const acted = await observeUnretriedFailure({
			failedId: "zai/glm-4.7",
			errorMessage: OLLAMA_QUOTA,
			stopReason: "error",
			jev: undefined,
			registry,
			now,
			blocked: readBlockedMap(now),
		});
		expect(acted).toBe(false);
		// Nothing to justify a block with, so the model stays usable.
		expect(isBlocked("zai/glm-4.7", now + 1_000, readBlockedMap(now + 1_000))).toBe(false);
	});

	it("leaves the model unblocked for a transient verdict, which pi already retried", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7" }],
			answer: { class: "transient", scope: "unknown" },
		});
		const now = Date.now();
		const acted = await observeUnretriedFailure({
			failedId: "zai/glm-4.7",
			errorMessage: "529 over_error: temporarily unavailable",
			stopReason: "error",
			jev: FALLBACKS.jev,
			registry,
			now,
			blocked: readBlockedMap(now),
		});
		expect(acted).toBe(false);
		expect(isBlocked("zai/glm-4.7", now + 1_000, readBlockedMap(now + 1_000))).toBe(false);
	});
});

describe("buildRoute — wire-up", () => {
	it("returns a ModelRoute with the picked model and thinking level", () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7" }],
		});
		const decision: Decision = { kind: "stick", modelId: "zai/glm-4.7", reason: "user" };
		const route = buildRoute(registry, decision, "high", undefined);
		expect(route.model.id).toBe("glm-4.7");
		expect(route.thinkingLevel).toBe("high");
	});

	it("throws when the picked model is not in the catalog", () => {
		const registry = makeFakeRegistry({ entries: [] });
		const decision: Decision = { kind: "switch", modelId: "missing/model", reason: "quota-fallback" };
		expect(() => buildRoute(registry, decision, "medium", undefined)).toThrow(/not in catalog/);
	});
});

describe("state persistence", () => {
	it("writes and reads the blocked-until map atomically", () => {
		const path = join(tmpDir, ".pi", "switchback.json");
		process.chdir(tmpDir);
		const now = Date.now();
		unblockModel("ollama-cloud/pro");
		blockModel("ollama-cloud/pro", now + 60_000, now, path);
		expect(existsSync(path)).toBe(true);
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
		expect(raw["ollama-cloud/pro"]).toBeGreaterThan(now);
	});

	it("prunes expired entries on read", () => {
		const path = join(tmpDir, ".pi", "switchback.json");
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		process.chdir(tmpDir);
		const past = Date.now() - 60_000;
		writeFileSync(path, JSON.stringify({ "zai/glm-4.7": past }));
		const live = readBlockedMap(Date.now(), path);
		expect(live["zai/glm-4.7"]).toBeUndefined();
	});
});

describe("config loader", () => {
	it("finds a config entry for switchback/auto", () => {
		// Write an explicit config so the test does not depend on a machine-local
		// config that happens to exist (isolated by PI_CODING_AGENT_DIR now).
		mkdirSync(join(tmpDir, ".pi"), { recursive: true });
		writeFileSync(
			join(tmpDir, ".pi", "switchback.yaml"),
			"models:\n  - id: switchback/auto\n    name: Auto (Switchback)\n    fallbacks:\n      - zai/glm-4.7\n",
		);
		const { config } = loadConfig();
		const entry = findModelConfig(config, "switchback/auto");
		expect(entry.fallbacks.length).toBeGreaterThan(0);
	});
});

describe("router — multi-model failover walk", () => {
	// The reported bug: after two models failed the router went back to the first
	// instead of reaching the third. Transient failures never block, so "advance" has
	// to move FORWARD through the configured order rather than restart at the head.
	it("walks forward through the list across consecutive transient failures", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
				{ provider: "minimax", id: "plus" },
			],
			answer: { class: "transient", scope: "account" },
		});
		const now = 1_000_000;
		const failed = (provider: string, id: string) => ({
			reason: "retry" as const,
			failed: { provider, id, errorMessage: OVERLOADED_529_MESSAGE },
		});

		// First transient failure on the head model: retry the same model.
		const first = await decide(
			"retry",
			buildFakeRequest({ ...failed("zai", "glm-4.7"), stateCurrent: "zai/glm-4.7", transientRetries: 0 }),
			FALLBACKS,
			registry,
			{ now, blocked: {} },
		);
		expect(first.decision.kind === "stick" ? first.decision.modelId : "").toBe("zai/glm-4.7");

		// Retry exhausted on the head: advance to the second entry.
		const second = await decide(
			"retry",
			buildFakeRequest({ ...failed("zai", "glm-4.7"), stateCurrent: "zai/glm-4.7", transientRetries: 1 }),
			FALLBACKS,
			registry,
			{ now, blocked: {} },
		);
		expect(second.decision.kind === "switch" ? second.decision.modelId : "").toBe("ollama-cloud/pro");

		// Retry exhausted on the second entry: must reach the THIRD, not bounce back.
		const third = await decide(
			"retry",
			buildFakeRequest({
				...failed("ollama-cloud", "pro"),
				stateCurrent: "ollama-cloud/pro",
				transientRetries: 1,
			}),
			FALLBACKS,
			registry,
			{ now, blocked: {} },
		);
		expect(third.decision.kind === "switch" ? third.decision.modelId : "").toBe("minimax/plus");
	});

	it("walks forward across consecutive quota blocks and then reports exhaustion", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
				{ provider: "minimax", id: "plus" },
				{ provider: "opencode-go", id: "pro" },
			],
			answer: { class: "quota", scope: "account" },
		});
		const now = 1_000_000;
		const failed = (provider: string, id: string) => ({
			reason: "retry" as const,
			failed: { provider, id, errorMessage: "429 quota exceeded" },
		});

		const first = await decide(
			"retry",
			buildFakeRequest({ ...failed("zai", "glm-4.7"), stateCurrent: "zai/glm-4.7" }),
			FALLBACKS,
			registry,
			{ now, blocked: {} },
		);
		expect(first.decision.kind === "switch" ? first.decision.modelId : "").toBe("ollama-cloud/pro");

		const blocked = { "zai/glm-4.7": now + 60_000 };
		const second = await decide(
			"retry",
			buildFakeRequest({ ...failed("ollama-cloud", "pro"), stateCurrent: "ollama-cloud/pro" }),
			FALLBACKS,
			registry,
			{ now, blocked },
		);
		expect(second.decision.kind === "switch" ? second.decision.modelId : "").toBe("minimax/plus");

		const third = await decide(
			"retry",
			buildFakeRequest({ ...failed("minimax", "plus"), stateCurrent: "minimax/plus" }),
			FALLBACKS,
			registry,
			{ now, blocked: { ...blocked, "ollama-cloud/pro": now + 60_000 } },
		);
		expect(third.decision.kind === "switch" ? third.decision.modelId : "").toBe("opencode-go/pro");

		const exhausted = await decide(
			"retry",
			buildFakeRequest({ ...failed("opencode-go", "pro"), stateCurrent: "opencode-go/pro" }),
			FALLBACKS,
			registry,
			{
				now,
				blocked: {
					"zai/glm-4.7": now + 60_000,
					"ollama-cloud/pro": now + 60_000,
					"minimax/plus": now + 60_000,
				},
			},
		);
		expect(exhausted.decision.kind).toBe("exhausted");
	});
});

describe("constants", () => {
	it("caps transient retries at one retry before moving on", () => {
		expect(MAX_TRANSIENT_RETRIES).toBe(1);
	});
});

describe("router — thinking level", () => {
	// The reported symptom: changing reasoning effort appeared to do nothing, because
	// the virtual level was handed to a physical model that does not implement it and
	// the provider fell back to its default. zai/glm-5.3 really is such a model.
	it("clamps a level the routed model does not implement (zai has no medium)", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7", thinkingLevelMap: { off: null, medium: null } }],
		});
		const request = buildFakeRequest({ reason: "user", noState: true });
		const result = await decide("user", request, FALLBACKS, registry, { now: 1_000_000, blocked: {} });
		const route = buildRoute(registry, result.decision, result.thinkingLevel, result.nextState);
		expect(route.thinkingLevel).toBe("high");
	});

	it("passes a supported level through unchanged", async () => {
		const registry = makeFakeRegistry({ entries: [{ provider: "zai", id: "glm-4.7" }] });
		const request = buildFakeRequest({ reason: "user", noState: true });
		const result = await decide("user", request, FALLBACKS, registry, { now: 1_000_000, blocked: {} });
		const route = buildRoute(registry, result.decision, result.thinkingLevel, result.nextState);
		expect(route.thinkingLevel).toBe("medium");
	});

	it("dispatches the level the classifier recommends for the activated model", async () => {
		// zai/glm-4.7 has no thinkingLevelMap here, so it supports off/minimal/medium/high;
		// the classifier is asked to resolve the user's ``medium`` against that set.
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7" }],
			levelAnswer: "high",
		});
		const request = buildFakeRequest({ reason: "user", noState: true });
		const result = await decide("user", request, FALLBACKS, registry, { now: 1_000_000, blocked: {} });
		expect(result.thinkingLevel).toBe("high");
		expect(result.thinkingSource).toBe("classifier");
	});

	it("clamps the requested level when the classifier has no answer for it", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7", thinkingLevelMap: { off: null, medium: null } }],
		});
		const request = buildFakeRequest({ reason: "user", noState: true });
		const result = await decide("user", request, FALLBACKS, registry, { now: 1_000_000, blocked: {} });
		expect(result.thinkingLevel).toBe("high");
		expect(result.thinkingSource).toBe("requested");
	});

	it("keeps the requested level on a sticky route (no classifier call)", async () => {
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7" }],
			levelAnswer: "high",
		});
		const request = buildFakeRequest({ reason: "user", stateCurrent: "zai/glm-4.7" });
		const result = await decide("user", request, FALLBACKS, registry, { now: 1_000_000, blocked: {} });
		expect(result.decision.kind).toBe("stick");
		expect(result.thinkingLevel).toBe("medium");
		expect(result.thinkingSource).toBeUndefined();
	});
});

describe("router — context-window fit on a switch (preference, not a filter)", () => {
	const BIG = 400_000;
	const SMALL = 32_000;
	// Enough to fit in a 400k window but not in a 32k one (16k reserve applies).
	const TOKENS = 100_000;

	it("prefers a candidate that can hold the context over the next one in list order", async () => {
		const result = await decide(
			"retry",
			buildFakeRequest({
				reason: "retry",
				stateCurrent: "zai/glm-4.7",
				failed: { provider: "zai", id: "glm-4.7", errorMessage: "quota exhausted" },
			}),
			FALLBACKS,
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7", contextWindow: BIG },
					{ provider: "ollama-cloud", id: "pro", contextWindow: SMALL },
					{ provider: "minimax", id: "plus", contextWindow: BIG },
				],
				answer: { class: "quota" },
			}),
			{ now: 1_000_000, blocked: {}, contextTokens: TOKENS },
		);
		// List order would pick ollama-cloud/pro (32k) and force compaction; the
		// fitting minimax/plus is preferred instead.
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") expect(result.decision.modelId).toBe("minimax/plus");
	});

	it("keeps the ordinary pick when nothing can hold the context (continuity wins)", async () => {
		const result = await decide(
			"retry",
			buildFakeRequest({
				reason: "retry",
				stateCurrent: "zai/glm-4.7",
				failed: { provider: "zai", id: "glm-4.7", errorMessage: "quota exhausted" },
			}),
			FALLBACKS,
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7", contextWindow: BIG },
					{ provider: "ollama-cloud", id: "pro", contextWindow: SMALL },
					{ provider: "minimax", id: "plus", contextWindow: SMALL },
				],
				answer: { class: "quota" },
			}),
			{ now: 1_000_000, blocked: {}, contextTokens: TOKENS },
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") expect(result.decision.modelId).toBe("ollama-cloud/pro");
	});

	it("does nothing when the context size is unknown", async () => {
		const result = await decide(
			"retry",
			buildFakeRequest({
				reason: "retry",
				stateCurrent: "zai/glm-4.7",
				failed: { provider: "zai", id: "glm-4.7", errorMessage: "quota exhausted" },
			}),
			FALLBACKS,
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7", contextWindow: BIG },
					{ provider: "ollama-cloud", id: "pro", contextWindow: SMALL },
					{ provider: "minimax", id: "plus", contextWindow: BIG },
				],
				answer: { class: "quota" },
			}),
			{ now: 1_000_000, blocked: {} },
		);
		if (result.decision.kind === "switch") expect(result.decision.modelId).toBe("ollama-cloud/pro");
	});

	it("lets the decision model choose among the candidates that fit", async () => {
		const result = await decide(
			"retry",
			buildFakeRequest({
				reason: "retry",
				stateCurrent: "zai/glm-4.7",
				failed: { provider: "zai", id: "glm-4.7", errorMessage: "quota exhausted" },
			}),
			FALLBACKS,
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7", contextWindow: BIG },
					{ provider: "ollama-cloud", id: "pro", contextWindow: BIG },
					{ provider: "minimax", id: "plus", contextWindow: BIG },
				],
				answer: { class: "quota" },
				// Deterministic order would pick ollama-cloud/pro; the decision model
				// sees both fitting candidates and picks minimax/plus.
				candidateAnswer: "minimax/plus",
			}),
			{ now: 1_000_000, blocked: {}, contextTokens: TOKENS },
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") expect(result.decision.modelId).toBe("minimax/plus");
	});

	it("keeps the deterministic candidate when the decision model cannot choose", async () => {
		const result = await decide(
			"retry",
			buildFakeRequest({
				reason: "retry",
				stateCurrent: "zai/glm-4.7",
				failed: { provider: "zai", id: "glm-4.7", errorMessage: "quota exhausted" },
			}),
			FALLBACKS,
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7", contextWindow: BIG },
					{ provider: "ollama-cloud", id: "pro", contextWindow: BIG },
					{ provider: "minimax", id: "plus", contextWindow: BIG },
				],
				answer: { class: "quota" },
			}),
			{ now: 1_000_000, blocked: {}, contextTokens: TOKENS },
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") expect(result.decision.modelId).toBe("ollama-cloud/pro");
	});

	it("never re-routes a sticky session, however large the context", async () => {
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro" }),
			FALLBACKS,
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7", contextWindow: BIG },
					{ provider: "ollama-cloud", id: "pro", contextWindow: SMALL },
				],
			}),
			{ now: 1_000_000, blocked: {}, contextTokens: TOKENS },
		);
		expect(result.decision.kind).toBe("stick");
		if (result.decision.kind === "stick") expect(result.decision.modelId).toBe("ollama-cloud/pro");
	});
});

describe("router — idle reset (switch to initial)", () => {
	const HOUR_MS = 3_600_000;
	// A realistic epoch: the idle measurement ignores a 0/negative stamp as
	// "unstamped", so the fake clock has to look like a real one.
	const NOW = 1_700_000_000_000;
	const withIdleReset = (idleReset: SwitchbackConfig["idleReset"]): SwitchbackConfig => ({ ...FALLBACKS, idleReset });
	const sixHoursAgo = NOW - 6 * HOUR_MS;

	it("stays sticky when idleReset is not configured (the default)", async () => {
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastMessageAt: sixHoursAgo }),
			FALLBACKS,
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
				],
			}),
			{ now: NOW, blocked: {} },
		);
		expect(result.decision.kind).toBe("stick");
		if (result.decision.kind === "stick") expect(result.decision.reason).toBe("session-sticky");
	});

	it("returns to the initial model once the fixed threshold is exceeded", async () => {
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastMessageAt: sixHoursAgo }),
			withIdleReset("5h"),
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
				],
			}),
			{ now: NOW, blocked: {} },
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("zai/glm-4.7");
			expect(result.decision.reason).toMatch(/^idle-reset-threshold/);
			expect(result.decision.reason).toMatch(/idle 6h >= 5h/);
		}
	});

	it("stays sticky below the threshold", async () => {
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastMessageAt: NOW - 1 * HOUR_MS }),
			withIdleReset("5h"),
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
				],
			}),
			{ now: NOW, blocked: {} },
		);
		expect(result.decision.kind).toBe("stick");
	});

	it("classifier mode returns to the initial model when the decision model says so", async () => {
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastMessageAt: sixHoursAgo }),
			withIdleReset("classifier"),
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
				],
				idleAnswer: "return_to_initial",
			}),
			{ now: NOW, blocked: {} },
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("zai/glm-4.7");
			expect(result.decision.reason).toMatch(/^idle-reset-classifier/);
		}
	});

	it("classifier mode keeps the current model when the decision model says so", async () => {
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastMessageAt: sixHoursAgo }),
			withIdleReset("classifier"),
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
				],
				idleAnswer: "keep_current",
			}),
			{ now: NOW, blocked: {} },
		);
		expect(result.decision.kind).toBe("stick");
		if (result.decision.kind === "stick") expect(result.decision.reason).toBe("session-sticky");
	});

	it("classifier mode is not asked below its floor (short idle stays sticky)", async () => {
		// No idleAnswer: if the router asked, the fake would resolve null and the
		// assertion below would not distinguish "not asked" from "asked". The floor
		// is what keeps a live session from paying for the call.
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastMessageAt: NOW - 10 * 60_000 }),
			withIdleReset("classifier"),
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
				],
			}),
			{ now: NOW, blocked: {} },
		);
		expect(result.decision.kind).toBe("stick");
	});

	it("a pin outranks the idle reset", async () => {
		setPinnedModel("switchback/auto", "ollama-cloud/pro");
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "minimax/plus", lastMessageAt: sixHoursAgo }),
			withIdleReset("5h"),
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
					{ provider: "minimax", id: "plus" },
				],
			}),
			{ now: NOW, blocked: {} },
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") {
			expect(result.decision.modelId).toBe("ollama-cloud/pro");
			expect(result.decision.reason).toBe("pinned");
		}
		setPinnedModel("switchback/auto", null);
	});

	it("skips a blocked initial model and lands on the next usable one", async () => {
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "minimax/plus", lastMessageAt: sixHoursAgo }),
			withIdleReset("5h"),
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
					{ provider: "minimax", id: "plus" },
				],
			}),
			{ now: NOW, blocked: { "zai/glm-4.7": NOW + HOUR_MS } },
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") expect(result.decision.modelId).toBe("ollama-cloud/pro");
	});

	it("leaves continuation and retry routes alone", async () => {
		const continuation = await decide(
			"continuation",
			buildFakeRequest({
				reason: "continuation",
				stateCurrent: "ollama-cloud/pro",
				previous: { provider: "ollama-cloud", id: "pro" },
				lastMessageAt: sixHoursAgo,
			}),
			withIdleReset("5h"),
			makeFakeRegistry({
				entries: [
					{ provider: "zai", id: "glm-4.7" },
					{ provider: "ollama-cloud", id: "pro" },
				],
			}),
			{ now: NOW, blocked: {} },
		);
		expect(continuation.decision.kind).toBe("stick");
		if (continuation.decision.kind === "stick") expect(continuation.decision.modelId).toBe("ollama-cloud/pro");
	});
});

describe("router — pin (manual override via /switchback-next)", () => {
	const writePin = (virtualId: string, model: string | null): void => {
		setPinnedModel(virtualId, model);
	};
	const messages: { text: string; type: string }[] = [];
	const notify = (text: string, type: "info" | "warning" | "error"): void => {
		messages.push({ text, type });
	};

	it("a usable pin wins stickiness and preference on user routes", async () => {
		messages.length = 0;
		writePin("switchback/auto", "ollama-cloud/pro");
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const result = await decide(
			"user",
			buildFakeRequest({ reason: "user", stateCurrent: "zai/glm-4.7" }),
			FALLBACKS,
			registry,
			{ now: 1_000_000, blocked: {} },
		);
		expect(result.decision.kind).toBe("switch");
		if (result.decision.kind === "switch") expect(result.decision.modelId).toBe("ollama-cloud/pro");
		expect(result.decision.reason).toBe("pinned");
	});

	it("a blocked pin is ignored (the model is not routed to)", async () => {
		writePin("switchback/auto", "ollama-cloud/pro");
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const result = await decide("user", buildFakeRequest({ reason: "user" }), FALLBACKS, registry, {
			now: 1_000_000,
			blocked: { "ollama-cloud/pro": 2_000_000 },
		});
		// Pinned model is blocked; fall through to stickiness on the head (which
		// happens to be the same head, so the result is a stick on the head).
		expect(result.decision.kind).toBe("stick");
		if (result.decision.kind === "stick") expect(result.decision.modelId).toBe("zai/glm-4.7");
	});

	it("debug emits a line on a manual-change that the staying model cannot express", async () => {
		messages.length = 0;
		writePin("switchback/auto", "zai/glm-4.7");
		const registry = makeFakeRegistry({
			entries: [{ provider: "zai", id: "glm-4.7", thinkingLevelMap: { off: null, minimal: null, medium: null } }],
		});
		await decide("user", buildFakeRequest({ reason: "user", stateCurrent: "zai/glm-4.7" }), FALLBACKS, registry, {
			now: 1_000_000,
			blocked: {},
			notify,
			debug: true,
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toMatch(/stays on zai\/glm-4\.7/);
		expect(messages[0]?.text).toMatch(/level medium →/);
	});

	it("debug emits no line for a manual change the staying model already supports", async () => {
		messages.length = 0;
		writePin("switchback/auto", "zai/glm-4.7");
		const registry = makeFakeRegistry({ entries: [{ provider: "zai", id: "glm-4.7" }] });
		await decide("user", buildFakeRequest({ reason: "user", stateCurrent: "zai/glm-4.7" }), FALLBACKS, registry, {
			now: 1_000_000,
			blocked: {},
			notify,
			debug: true,
		});
		expect(messages).toHaveLength(0);
	});
});

describe("router — debug diagnostics on a switch", () => {
	const messages: { text: string; type: string }[] = [];
	const notify = (text: string, type: "info" | "warning" | "error"): void => {
		messages.push({ text, type });
	};
	beforeEach(() => {
		messages.length = 0;
	});

	it("emits one line per switch with the verdict and the level resolution", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
			answer: { class: "quota", scope: "account" },
			levelAnswer: "high",
		});
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "zai", id: "glm-4.7", errorMessage: "429 quota exceeded" },
			stateCurrent: "zai/glm-4.7",
		});
		await decide("retry", request, FALLBACKS, registry, { now: 1_000_000, blocked: {}, notify, debug: true });
		expect(messages).toHaveLength(1);
		expect(messages[0]?.type).toBe("info");
		// from -> to, decision reason, requested -> dispatched level and its source
		expect(messages[0]?.text).toMatch(/switchback: switch zai\/glm-4\.7 → ollama-cloud\/pro \[quota-fallback\]/);
		expect(messages[0]?.text).toMatch(/level medium → high \(classifier, confidence/);
	});

	it("emits the reset window a blocked model received", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
			answer: { class: "quota", scope: "account", resetScore: 4 },
			levelAnswer: "high",
		});
		const request = buildFakeRequest({
			reason: "retry",
			failed: { provider: "zai", id: "glm-4.7", errorMessage: "429 quota exceeded" },
			stateCurrent: "zai/glm-4.7",
		});
		await decide("retry", request, FALLBACKS, registry, { now: 1_000_000, blocked: {}, notify, debug: true });
		expect(messages[0]?.text).toMatch(/\[quota-fallback \(reset in \d+ min\)\]/);
	});

	it("does not emit when the decision is a sticky same-model route", async () => {
		const sticky = makeFakeRegistry({ entries: [{ provider: "zai", id: "glm-4.7" }], levelAnswer: "high" });
		await decide("user", buildFakeRequest({ reason: "user", stateCurrent: "zai/glm-4.7" }), FALLBACKS, sticky, {
			now: 1_000_000,
			blocked: {},
			notify,
			debug: true,
		});
		expect(messages).toHaveLength(0);
	});

	it("stays silent without the debug flag even on a switch", async () => {
		const switching = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
			answer: { class: "quota", scope: "account" },
			levelAnswer: "high",
		});
		await decide(
			"retry",
			buildFakeRequest({
				reason: "retry",
				failed: { provider: "zai", id: "glm-4.7", errorMessage: "429" },
				stateCurrent: "zai/glm-4.7",
			}),
			FALLBACKS,
			switching,
			{ now: 1_000_000, blocked: {}, notify },
		);
		expect(messages).toHaveLength(0);
	});
});
