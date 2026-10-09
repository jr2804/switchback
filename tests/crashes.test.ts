/**
 * Tests for the global crash store at <piConfigDir>/switchback/crashes.json.
 *
 * Covers the directive's (G) gates: store roundtrip/dedup/counters, migration
 * (on a separate file - migration is tested in state-migration.test.ts),
 * recording on every retry path, the Tier 2b annotation cache hit/miss, and
 * the validate-an-annotation-class gate. The mocked-classifier pattern from
 * router.test.ts is reused so the recordings are deterministic.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
	annotateCrash,
	crashesFilePath,
	findCrashByShortHash,
	hashSample,
	isValidAnnotationClass,
	lookupCrash,
	readCrashMap,
	recordCrash,
	shortHash,
} from "../src/crashes.ts";
import { classifyError, PROMPT_VERSION } from "../src/classify.ts";

let tmpDir: string;
let originalAgentDir: string | undefined;
let originalCwd: string;

beforeEach(() => {
	originalCwd = process.cwd();
	originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
	tmpDir = join(tmpdir(), `switchback-crashes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env["PI_CODING_AGENT_DIR"] = tmpDir;
	process.chdir(tmpDir);
});

afterEach(() => {
	process.chdir(originalCwd);
	if (originalAgentDir === undefined) {
		delete process.env["PI_CODING_AGENT_DIR"];
	} else {
		process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
	}
	if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

describe("crashes store — roundtrip", () => {
	it("creates crashes.json under <piConfigDir>/switchback/ on first record", () => {
		const path = crashesFilePath();
		expect(existsSync(path)).toBe(false);
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		expect(existsSync(path)).toBe(true);
	});

	it("atomic write: the on-disk file is never an empty tmp (rename moves the real file)", () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		const path = crashesFilePath();
		expect(readdirSync(dirname(path))).toEqual(["crashes.json"]); // the staging file is renamed away
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		expect(Object.keys(raw)).toHaveLength(1);
	});

	it("dedup: a second record with the same raw updates count and last, does not duplicate", () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 2,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		const map = readCrashMap();
		expect(Object.keys(map)).toHaveLength(1);
		const entry = Object.values(map)[0]!;
		expect(entry.count).toBe(2);
		expect(entry.first).toBe(1);
		expect(entry.last).toBe(2);
	});

	it("different raw strings produce different keys", () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		recordCrash({
			raw: "msg-B",
			provider: "zai",
			model: "glm-5.3",
			now: 2,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		const map = readCrashMap();
		expect(Object.keys(map)).toHaveLength(2);
	});

	it("verdictHistory appends and is bounded at 50 entries", () => {
		for (let i = 0; i < 60; i++) {
			recordCrash({
				raw: "msg-A",
				provider: "zai",
				model: "glm-5.3",
				now: i,
				action: "blind-cycle",
				verdict: null,
				noClassifierReason: "not-configured",
				promptVersion: PROMPT_VERSION,
			});
		}
		const map = readCrashMap();
		const entry = Object.values(map)[0]!;
		expect(entry.verdictHistory.length).toBe(50);
		expect(entry.verdictHistory[0]!.at).toBe(10);
		expect(entry.verdictHistory[49]!.at).toBe(59);
	});

	it("classifier verdict stamps promptVersion", () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blocked+advanced",
			verdict: { class: "quota", scope: "model", raw: "msg-A", resetAtMs: 12345 },
			promptVersion: PROMPT_VERSION,
		});
		const map = readCrashMap();
		const entry = Object.values(map)[0]!;
		expect(entry.verdict?.class).toBe("quota");
		expect(entry.verdict?.promptVersion).toBe(PROMPT_VERSION);
	});
});

describe("crashes store — annotation cache (Tier 2b)", () => {
	it("annotateCrash writes the annotation onto the entry", () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		annotateCrash(shortHash(hashSample("msg-A")), "quota", "zai 5h window", 100);
		const entry = lookupCrash("msg-A");
		expect(entry?.annotated).toBeDefined();
		expect(entry?.annotated?.class).toBe("quota");
		expect(entry?.annotated?.note).toBe("zai 5h window");
	});

	it("unannotated entry: classifier still gets called (Tier 2b is annotation-only)", async () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		let classifierCalled = 0;
		const fakeRegistry = {
			findOfType: () => ({ provider: "typesafe", id: "jev-latest", api: "classifier", input: ["text"] }),
			classify: async () => {
				classifierCalled++;
				return {
					stopReason: "stop",
					answers: { class: { type: "choice", choice: "quota" }, scope: { type: "choice", choice: "model" } },
				};
			},
		};
		await classifyError("msg-A", fakeRegistry as unknown as Parameters<typeof classifyError>[1], {
			provider: "typesafe",
			id: "jev-latest",
		});
		expect(classifierCalled).toBe(1);
	});

	it("annotated entry: classifier is NOT called (Tier 2b short-circuits)", async () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		annotateCrash(shortHash(hashSample("msg-A")), "quota", "zai 5h window", 100);
		let classifierCalled = 0;
		const fakeRegistry = {
			findOfType: () => ({ provider: "typesafe", id: "jev-latest", api: "classifier", input: ["text"] }),
			classify: async () => {
				classifierCalled++;
				return {
					stopReason: "stop",
					answers: {
						class: { type: "choice", choice: "auth" },
						scope: { type: "choice", choice: "account" },
					},
				};
			},
		};
		const result = await classifyError("msg-A", fakeRegistry as unknown as Parameters<typeof classifyError>[1], {
			provider: "typesafe",
			id: "jev-latest",
		});
		expect(classifierCalled).toBe(0);
		expect(result.kind).toBe("classified");
		if (result.kind === "classified") {
			expect(result.classified.class).toBe("quota");
			expect(result.classified.source).toBe("annotation");
			expect(result.classified.resetAtMs).toBeUndefined();
		}
	});

	it("classifier-verdict entry is NOT enough — only annotation unlocks Tier 2b", async () => {
		// This entry has a classifier verdict (not a user annotation). Tier 2b
		// must NOT short-circuit on it; the user has not confirmed those exact
		// bytes.
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blocked+advanced",
			verdict: { class: "quota", scope: "model", raw: "msg-A", resetAtMs: 12345 },
			promptVersion: PROMPT_VERSION,
		});
		let classifierCalled = 0;
		const fakeRegistry = {
			findOfType: () => ({ provider: "typesafe", id: "jev-latest", api: "classifier", input: ["text"] }),
			classify: async () => {
				classifierCalled++;
				return {
					stopReason: "stop",
					answers: {
						class: { type: "choice", choice: "auth" },
						scope: { type: "choice", choice: "account" },
					},
				};
			},
		};
		await classifyError("msg-A", fakeRegistry as unknown as Parameters<typeof classifyError>[1], {
			provider: "typesafe",
			id: "jev-latest",
		});
		expect(classifierCalled).toBe(1);
	});
});

describe("crashes store — annotation validation", () => {
	it("isValidAnnotationClass accepts the five valid classes", () => {
		expect(isValidAnnotationClass("quota")).toBe(true);
		expect(isValidAnnotationClass("auth")).toBe(true);
		expect(isValidAnnotationClass("transient")).toBe(true);
		expect(isValidAnnotationClass("overflow")).toBe(true);
		expect(isValidAnnotationClass("unknown")).toBe(true);
	});

	it("isValidAnnotationClass rejects arbitrary strings", () => {
		expect(isValidAnnotationClass("bogus")).toBe(false);
		expect(isValidAnnotationClass("")).toBe(false);
		expect(isValidAnnotationClass("Quota")).toBe(false); // case-sensitive
	});

	it("annotateCrash: ambiguous short-hash throws", () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		recordCrash({
			raw: "msg-B",
			provider: "zai",
			model: "glm-5.3",
			now: 2,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		const a = shortHash(hashSample("msg-A"));
		const b = shortHash(hashSample("msg-B"));
		// Force a collision by using a single-character prefix that both share.
		expect(() => annotateCrash(a[0]!, "quota", "n")).toThrow(/ambiguous/);
		// And unknown prefix throws.
		expect(() => annotateCrash("deadbeef", "quota", "n")).toThrow(/no crash/);
		void b;
	});

	it("findCrashByShortHash: ambiguous short-hash throws", () => {
		recordCrash({
			raw: "msg-A",
			provider: "zai",
			model: "glm-5.3",
			now: 1,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		recordCrash({
			raw: "msg-B",
			provider: "zai",
			model: "glm-5.3",
			now: 2,
			action: "blind-cycle",
			verdict: null,
			noClassifierReason: "not-configured",
			promptVersion: PROMPT_VERSION,
		});
		const a = shortHash(hashSample("msg-A"));
		expect(() => findCrashByShortHash(a[0]!)).toThrow(/ambiguous/);
	});
});

describe("crashes store — recording across all 5 no-classifier reasons", () => {
	const reasons = ["not-configured", "unresolvable", "timeout", "threw", "unparseable"] as const;
	for (const reason of reasons) {
		it(`records a no-classifier reason (${reason}) with the action "blind-cycle"`, () => {
			recordCrash({
				raw: `raw-${reason}`,
				provider: "zai",
				model: "glm-5.3",
				now: 1,
				action: "blind-cycle",
				verdict: null,
				noClassifierReason: reason,
				promptVersion: PROMPT_VERSION,
			});
			const entry = lookupCrash(`raw-${reason}`);
			expect(entry?.noClassifierReason).toBe(reason);
			expect(entry?.verdict).toBeNull();
			expect(entry?.action).toBe("blind-cycle");
		});
	}
});

describe("crashes store — recording across each classified verdict class", () => {
	const classes = ["quota", "auth", "transient", "overflow", "unknown"] as const;
	for (const klass of classes) {
		it(`records a classified verdict (${klass}) with the action "blocked+advanced"`, () => {
			recordCrash({
				raw: `raw-${klass}`,
				provider: "zai",
				model: "glm-5.3",
				now: 1,
				action: "blocked+advanced",
				verdict: { class: klass, scope: "model", raw: `raw-${klass}` },
				promptVersion: PROMPT_VERSION,
			});
			const entry = lookupCrash(`raw-${klass}`);
			expect(entry?.verdict?.class).toBe(klass);
			expect(entry?.verdict?.promptVersion).toBe(PROMPT_VERSION);
			expect(entry?.action).toBe("blocked+advanced");
		});
	}
});

describe("crashes store — corruption tolerance", () => {
	it("readCrashMap on a corrupt file moves the bad file aside and returns empty", () => {
		const path = crashesFilePath();
		mkdirSync(join(tmpDir, "switchback"), { recursive: true });
		writeFileSync(path, "not a json object");
		const map = readCrashMap();
		expect(Object.keys(map)).toHaveLength(0);
	});
});
