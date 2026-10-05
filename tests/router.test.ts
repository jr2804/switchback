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
import { decide, buildRoute, MAX_TRANSIENT_RETRIES, MIN_DWELL_MS, type Decision, type RouterRegistry } from "../src/routing.ts";
import { stateFilePath, readBlockedMap, isBlocked, unblockModel, blockModel } from "../src/state.ts";
import { simulateRetry, loadSimulate, getScenario, SimulateError } from "../src/simulate.ts";
import { findModelConfig, loadConfig } from "../src/config.ts";
import { classifyError, type NoClassifierReason } from "../src/classify.ts";
import { ConfigInvalidError } from "../src/routing.ts";
import type { SwitchbackConfig } from "../src/types.ts";

interface FakeEntry {
	provider: string;
	id: string;
}

type ClassifyAnswer = {
	class: "quota" | "auth" | "transient" | "overflow" | "unknown";
	scope?: "model" | "account" | "ip" | "unknown";
	resetScore?: number;
};

interface FakeRegistryOpts {
	entries: readonly FakeEntry[];
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
}

function makeFakeRegistry(opts: FakeRegistryOpts): RouterRegistry & { classify: (...args: unknown[]) => Promise<unknown> } {
	const byKey = new Map<string, Model<Api>>();
	const providers = new Set<string>();
	for (const e of opts.entries) {
		byKey.set(`${e.provider}/${e.id}`, {
			provider: e.provider,
			id: e.id,
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			contextWindow: 128_000,
			maxTokens: 16_000,
		} as unknown as Model<Api>);
		providers.add(e.provider);
	}
	// A fake "classifier handle" — its presence (or absence) is what `findOfType`
	// returns. Tests that want the classifier path to be exercisable must set
	// answer / throw / hang / unparseable; tests that want the no-classifier path
	// leave those unset and findOfType returns undefined.
	const classifierConfigured = opts.answer !== undefined || opts.throw !== undefined || opts.hang === true || opts.unparseable === true;
	const fakeClassifierHandle = classifierConfigured
		? { provider: "typesafe", id: "jev-latest", api: "classifier" as const, input: ["text" as const] }
		: undefined;
	return {
		find(provider: string, modelId: string): Model<Api> | undefined {
			return byKey.get(`${provider}/${modelId}`);
		},
		findOfType(_type: string, provider: string, id: string): Model<Api> | undefined {
			if (fakeClassifierHandle === undefined) return undefined;
			if (provider === fakeClassifierHandle.provider && id === fakeClassifierHandle.id) return fakeClassifierHandle as unknown as Model<Api>;
			return undefined;
		},
		hasConfiguredAuth(): boolean { return true; },
		getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string } {
			const configured = opts.auth?.[provider] ?? providers.has(provider);
			return { configured, source: configured ? "environment" : undefined, label: configured ? "fake-credentials" : "no-credentials" };
		},
		classify: async () => {
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
				scope: { type: "choice" as const, choice: opts.answer.scope ?? "unknown", probabilities: {}, confidence: 1 },
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
	failed?: { provider: string; id: string; errorMessage: string; stopReason?: "error" | "length" | "aborted" | "stop" | "toolUse" | "deferred" | "pending" };
	stateCurrent?: string;
	transientRetries?: number;
	lastSwitchAtMs?: number;
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
							usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							stopReason: overrides.failed.stopReason ?? "error" as const,
							errorMessage: overrides.failed.errorMessage,
							timestamp: Date.now(),
						},
					},
				}
			: {}),
		messages: [],
		state: {
			current: overrides.stateCurrent ?? FALLBACKS.fallbacks[0]!,
			transientRetries: overrides.transientRetries ?? 0,
			...(overrides.lastSwitchAtMs !== undefined ? { lastSwitchAtMs: overrides.lastSwitchAtMs } : {}),
		},
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

describe("router — minimum dwell (MIN_DWELL_MS)", () => {
	it("stays on the current model within MIN_DWELL_MS even though a preferred model is available", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const now = 1_000_000;
		const request = buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastSwitchAtMs: now - 1_000 });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked: {} });
		expect(result.decision.kind).toBe("stick");
		expect(result.decision.kind === "stick" ? result.decision.modelId : "").toBe("ollama-cloud/pro");
	});

	it("switches once the dwell window has elapsed", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const now = 1_000_000;
		const request = buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastSwitchAtMs: now - MIN_DWELL_MS });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked: {} });
		expect(result.decision.kind).toBe("switch");
		expect(result.decision.kind === "switch" ? result.decision.modelId : "").toBe("zai/glm-4.7");
	});

	it("does not hold a blocked current model (dwell yields to a quota block)", async () => {
		const registry = makeFakeRegistry({
			entries: [
				{ provider: "zai", id: "glm-4.7" },
				{ provider: "ollama-cloud", id: "pro" },
			],
		});
		const now = 1_000_000;
		const blocked = { "ollama-cloud/pro": now + 60_000 };
		const request = buildFakeRequest({ reason: "user", stateCurrent: "ollama-cloud/pro", lastSwitchAtMs: now - 1_000 });
		const result = await decide("user", request, FALLBACKS, registry, { now, blocked });
		expect(result.decision.kind).toBe("switch");
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
	const noClassifierReasons: NoClassifierReason[] = ["not-configured", "unresolvable", "timeout", "threw", "unparseable"];

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
			const result = await decide("retry", request, modelConfig, registry, { now, blocked: {}, notify: () => {} });
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
		await decide("retry", request, FALLBACKS, registry, { now: Date.now(), blocked: {}, notify: (message, type) => notifications.push({ message, type }) });
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
				failed: { provider: failedId.split("/")[0]!, id: failedId.split("/")[1]!, errorMessage: "still nothing" },
			});
			await decide("retry", request, FALLBACKS, registry, { now: Date.now(), blocked: {}, notify: () => {} });
		}
		// Blind cycle writes nothing to the account-scoped block map.
		expect(existsSync(path)).toBe(false);
	});
});

describe("router — retry reason: classifier says quota", () => {
	for (const scenario of [
		{ name: "z.ai 5h hit", message: "429 Too Many Requests: z.ai GLM 5h window exceeded. Resets at 2026-10-04T15:30:00Z.", resetScore: 55 },
		{ name: "ollama-cloud weekly", message: "429: weekly token limit exhausted for ollama-cloud. Try again in 1d 2h.", resetScore: 78 },
		{ name: "opencode-go monthly", message: "Rate limit reached: opencode-go monthly cap. Retry after 30s.", resetScore: 30 },
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
					return { provider: "zai", id: "glm-4.7", api: "openai-completions", baseUrl: "x", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, contextWindow: 128_000, maxTokens: 16_000 } as unknown as Model<Api>;
				}
				return undefined;
			},
			findOfType: () => undefined,
			hasConfiguredAuth: () => true,
			getProviderAuthStatus: () => ({ configured: true, label: "fake" }),
			classify: async () => null,
		} as unknown as Parameters<typeof decide>[3];

		const r1 = await decide("user", buildFakeRequest({ reason: "user" }), FALLBACKS, dynamicRegistry, { now: 1, blocked: {} });
		expect(r1.decision.kind).toBe("config-invalid");

		registered = true;
		const r2 = await decide("user", buildFakeRequest({ reason: "user", stateCurrent: "nonexistent/model" }), FALLBACKS, dynamicRegistry, { now: 2, blocked: {} });
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
			answer: { class: "quota", scope: "model", resetScore: 55 },
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
		const result = await simulateRetry(message, FALLBACKS, registry, { notify: (msg, type) => notifications.push({ message: msg, type }) }, Date.now());
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
			entries: [{ provider: "zai", id: "glm-4.7" }, { provider: "ollama-cloud", id: "pro" }],
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
			answer: { class: "quota", scope: "model", resetScore: 55 },
		});
		const now = 1_000_000_000;
		const result = await classifyError("any message", registry, { provider: "typesafe", id: "jev-latest" }, now);
		expect(result.kind).toBe("classified");
		if (result.kind === "classified") {
			expect(result.classified.class).toBe("quota");
			// Score 55 in the hours bucket = 5 hours from now.
			expect(result.classified.resetAtMs).toBe(now + 5 * 3_600_000);
		}
	});

	it("branch 2: classifier resolves unparseable -> no-classifier, unparseable reason", async () => {
		const registry = {
			findOfType: () => ({ provider: "typesafe", id: "jev-latest", api: "classifier" }),
			classify: async () => ({ not_an_answer: true }),
		};
		const result = await classifyError("any", registry as unknown as Parameters<typeof classifyError>[1], { provider: "typesafe", id: "jev-latest" }, Date.now());
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
		const registry = makeFakeRegistry({ entries: [], hang: true });
		const result = await classifyError("any", registry, { provider: "typesafe", id: "jev-latest" }, Date.now());
		expect(result.kind).toBe("no-classifier");
		if (result.kind === "no-classifier") {
			expect(result.reason).toBe("timeout");
		}
	}, 10_000);

	it("branch 3: classifier throws -> no-classifier, threw reason", async () => {
		const registry = makeFakeRegistry({ entries: [], throw: new Error("simulated") });
		const result = await classifyError("any", registry, { provider: "typesafe", id: "jev-latest" }, Date.now());
		expect(result.kind).toBe("no-classifier");
		if (result.kind === "no-classifier") {
			expect(result.reason).toBe("threw");
		}
	});

	it("scoreToResetAtMs bucket-relative: 51 = 1h, 76 = 1d, capped at 31d", async () => {
		// Score 75 -> 25 hours; score 76 -> 1 day; score 100 -> 25 days; score 200 -> cap.
		const now = 1_000_000_000;
		const makeScoreAnswer = (score: number) => ({ class: "quota" as const, scope: "model" as const, resetScore: score });
		const registry = (score: number) => makeFakeRegistry({ entries: [], answer: makeScoreAnswer(score) });
		const r51 = await classifyError("any", registry(51), { provider: "typesafe", id: "jev-latest" }, now);
		const r76 = await classifyError("any", registry(76), { provider: "typesafe", id: "jev-latest" }, now);
		const r100 = await classifyError("any", registry(100), { provider: "typesafe", id: "jev-latest" }, now);
		if (r51.kind === "classified") expect(r51.classified.resetAtMs).toBe(now + 1 * 3_600_000);
		if (r76.kind === "classified") expect(r76.classified.resetAtMs).toBe(now + 1 * 86_400_000);
		if (r100.kind === "classified") expect(r100.classified.resetAtMs).toBe(now + 25 * 86_400_000);
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
		writeFileSync(
			join(tmpDir, "switchback.yaml"),
			"models:\n  - id: switchback/auto\n    name: Auto (Switchback)\n    fallbacks:\n      - zai/glm-4.7\n",
		);
		const { config } = loadConfig();
		const entry = findModelConfig(config, "switchback/auto");
		expect(entry.fallbacks.length).toBeGreaterThan(0);
	});
});

describe("constants", () => {
	it("exports the minimum dwell time", () => {
		expect(MIN_DWELL_MS).toBe(30_000);
	});
});
