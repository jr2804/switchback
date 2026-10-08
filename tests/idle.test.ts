/**
 * Unit tests for the idle-reset decision (`src/idle.ts`).
 *
 * The router-level integration (a route actually moving back to the head) lives
 * in `tests/router.test.ts`; this suite pins the arithmetic, the timestamp
 * extraction and the classifier contract in isolation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
	decideIdleReset,
	formatIdle,
	idleMsSince,
	idleResetThresholdMs,
	isIdleResetDuration,
	lastMessageTimestamp,
	IDLE_CLASSIFIER_FLOOR_MS,
	IDLE_RESET_OPTIONS,
} from "../src/idle.ts";
import type { ClassifierRegistry } from "../src/classify.ts";

const MINUTE = 60_000;
const HOUR = 3_600_000;
/** A realistic epoch base: the module treats a 0/negative stamp as "unstamped". */
const T0 = 1_700_000_000_000;

/** A minimal user message; only `timestamp` matters to this module. */
function messageAt(timestamp: number): Message {
	return { role: "user", content: "hello", timestamp } as Message;
}

/** A registry whose classifier handle is present and answers with `choice`. */
function classifierAnswering(choice: string | undefined): ClassifierRegistry {
	return {
		find: () => undefined,
		findOfType: () =>
			({
				provider: "typesafe",
				id: "jev-latest",
				api: "classifier",
				input: ["text"],
			}) as unknown as ReturnType<ClassifierRegistry["findOfType"]>,
		classify: async () => {
			if (choice === undefined) return null;
			return {
				stopReason: "stop" as const,
				answers: { idle_reset: { type: "choice" as const, choice, probabilities: {}, confidence: 1 } },
			};
		},
	} as unknown as ClassifierRegistry;
}

/** A registry with no classifier handle at all (the no-classifier path). */
function classifierAbsent(): ClassifierRegistry {
	return {
		find: () => undefined,
		findOfType: () => undefined,
		classify: async () => null,
	} as unknown as ClassifierRegistry;
}

describe("idle — options and thresholds", () => {
	it("lists every accepted value with never first", () => {
		expect(IDLE_RESET_OPTIONS[0]).toBe("never");
		expect(IDLE_RESET_OPTIONS).toContain("classifier");
		expect(IDLE_RESET_OPTIONS).toHaveLength(9);
	});

	it("maps durations to milliseconds and leaves never/classifier open", () => {
		expect(idleResetThresholdMs("30m")).toBe(30 * MINUTE);
		expect(idleResetThresholdMs("5h")).toBe(5 * HOUR);
		expect(idleResetThresholdMs("24h")).toBe(24 * HOUR);
		expect(idleResetThresholdMs("never")).toBeUndefined();
		expect(idleResetThresholdMs("classifier")).toBeUndefined();
		expect(idleResetThresholdMs(undefined)).toBeUndefined();
	});

	it("distinguishes durations from the two open modes", () => {
		expect(isIdleResetDuration("1h")).toBe(true);
		expect(isIdleResetDuration("never")).toBe(false);
		expect(isIdleResetDuration("classifier")).toBe(false);
	});
});

describe("idle — timestamp extraction", () => {
	it("returns undefined for a conversation without messages", () => {
		expect(lastMessageTimestamp([])).toBeUndefined();
		expect(idleMsSince([], 1_000)).toBeUndefined();
	});

	it("takes the newest usable stamp, ignoring zero and non-finite ones", () => {
		const messages = [messageAt(0), messageAt(500), messageAt(Number.NaN), messageAt(900)];
		expect(lastMessageTimestamp(messages)).toBe(900);
	});

	it("clamps a future timestamp to zero idle instead of a negative duration", () => {
		expect(idleMsSince([messageAt(2_000)], 1_000)).toBe(0);
	});
});

describe("idle — formatting", () => {
	it("formats minutes, whole hours and mixed durations", () => {
		expect(formatIdle(45 * MINUTE)).toBe("45m");
		expect(formatIdle(6 * HOUR)).toBe("6h");
		expect(formatIdle(6 * HOUR + 12 * MINUTE)).toBe("6h 12m");
		expect(formatIdle(0)).toBe("0m");
	});
});

describe("idle — decisions", () => {
	it("does nothing when the option is absent or never", async () => {
		const base = {
			messages: [messageAt(T0)],
			now: T0 + 10 * HOUR,
			currentModel: "ollama-cloud/pro",
			candidates: ["zai/glm-4.7"],
			blockedNotes: [],
		};
		const absent = await decideIdleReset({
			...base,
			registry: classifierAbsent(),
			jev: undefined,
			option: undefined,
		});
		expect(absent.reset).toBe(false);
		expect(absent.source).toBe("none");
		const never = await decideIdleReset({ ...base, registry: classifierAbsent(), jev: undefined, option: "never" });
		expect(never.reset).toBe(false);
	});

	it("does nothing when the conversation carries no usable timestamp", async () => {
		const decision = await decideIdleReset({
			registry: classifierAbsent(),
			jev: undefined,
			option: "5h",
			messages: [],
			now: T0 + 10 * HOUR,
			currentModel: "ollama-cloud/pro",
			candidates: ["zai/glm-4.7"],
			blockedNotes: [],
		});
		expect(decision.reset).toBe(false);
		expect(decision.reason).toMatch(/no message timestamp/);
	});

	it("resets at or above a fixed threshold and stays below it", async () => {
		const at = await decideIdleReset({
			registry: classifierAbsent(),
			jev: undefined,
			option: "5h",
			messages: [messageAt(T0)],
			now: T0 + 5 * HOUR,
			currentModel: "ollama-cloud/pro",
			candidates: ["zai/glm-4.7"],
			blockedNotes: [],
		});
		expect(at.reset).toBe(true);
		expect(at.source).toBe("threshold");
		expect(at.reason).toMatch(/idle 5h >= 5h/);

		const below = await decideIdleReset({
			registry: classifierAbsent(),
			jev: undefined,
			option: "5h",
			messages: [messageAt(T0)],
			now: T0 + 5 * HOUR - MINUTE,
			currentModel: "ollama-cloud/pro",
			candidates: ["zai/glm-4.7"],
			blockedNotes: [],
		});
		expect(below.reset).toBe(false);
	});

	it("does not ask the classifier below the floor", async () => {
		const decision = await decideIdleReset({
			registry: classifierAnswering("return_to_initial"),
			jev: { provider: "typesafe", id: "jev-latest" },
			option: "classifier",
			messages: [messageAt(T0)],
			now: T0 + IDLE_CLASSIFIER_FLOOR_MS - MINUTE,
			currentModel: "ollama-cloud/pro",
			candidates: ["zai/glm-4.7"],
			blockedNotes: [],
		});
		expect(decision.reset).toBe(false);
		expect(decision.reason).toMatch(/below the 30m classifier floor/);
	});

	it("follows the classifier's return answer above the floor", async () => {
		const decision = await decideIdleReset({
			registry: classifierAnswering("return_to_initial"),
			jev: { provider: "typesafe", id: "jev-latest" },
			option: "classifier",
			messages: [messageAt(T0)],
			now: T0 + 8 * HOUR,
			currentModel: "ollama-cloud/pro",
			candidates: ["zai/glm-4.7", "ollama-cloud/pro"],
			blockedNotes: ["minimax/plus (resets in 20 min)"],
		});
		expect(decision.reset).toBe(true);
		expect(decision.source).toBe("classifier");
		expect(decision.reason).toMatch(/return to zai\/glm-4\.7/);
		expect(decision.confidence).toBe(1);
	});

	it("keeps the current model on a keep answer", async () => {
		const decision = await decideIdleReset({
			registry: classifierAnswering("keep_current"),
			jev: { provider: "typesafe", id: "jev-latest" },
			option: "classifier",
			messages: [messageAt(T0)],
			now: T0 + 8 * HOUR,
			currentModel: "ollama-cloud/pro",
			candidates: ["zai/glm-4.7"],
			blockedNotes: [],
		});
		expect(decision.reset).toBe(false);
		expect(decision.source).toBe("classifier");
	});

	it("keeps the current model when the classifier is unavailable or unreadable", async () => {
		const base = {
			jev: { provider: "typesafe", id: "jev-latest" },
			option: "classifier" as const,
			messages: [messageAt(T0)],
			now: T0 + 8 * HOUR,
			currentModel: "ollama-cloud/pro",
			candidates: ["zai/glm-4.7"],
			blockedNotes: [],
		};
		// A configured classifier handle that the registry cannot resolve.
		const absent = await decideIdleReset({ ...base, registry: classifierAbsent() });
		expect(absent.reset).toBe(false);
		expect(absent.noClassifierReason).toBe("unresolvable");

		// No classifier configured at all (the model has no `jev:`).
		const notConfigured = await decideIdleReset({ ...base, jev: undefined, registry: classifierAbsent() });
		expect(notConfigured.reset).toBe(false);
		expect(notConfigured.noClassifierReason).toBe("not-configured");

		const unreadable = await decideIdleReset({ ...base, registry: classifierAnswering(undefined) });
		expect(unreadable.reset).toBe(false);
		expect(unreadable.noClassifierReason).toBe("timeout");
	});

	it("does not reset to an initial model when none is usable", async () => {
		const decision = await decideIdleReset({
			registry: classifierAnswering("return_to_initial"),
			jev: { provider: "typesafe", id: "jev-latest" },
			option: "classifier",
			messages: [messageAt(T0)],
			now: T0 + 8 * HOUR,
			currentModel: "ollama-cloud/pro",
			candidates: [],
			blockedNotes: ["zai/glm-4.7 (resets in 20 min)"],
		});
		expect(decision.reset).toBe(false);
		expect(decision.reason).toMatch(/no usable initial model/);
	});
});

// The module touches no store, but the router does; keep the suite hermetic so a
// stray PI_CODING_AGENT_DIR from the environment cannot leak into a run.
let tmpDir: string;
beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "switchback-idle-"));
	process.env["PI_CODING_AGENT_DIR"] = tmpDir;
});
afterEach(() => {
	delete process.env["PI_CODING_AGENT_DIR"];
	rmSync(tmpDir, { recursive: true, force: true });
});
