/**
 * Tests for the manual disable list (`disabled.json`) in packages/core/src/state.ts.
 *
 * The list is a store, not a policy: entries never expire and nothing here reads
 * the clock beyond the `disabledAt` stamp kept for display. Every case passes an
 * explicit file path, so the suite never touches the real state directory.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearDisabled, disableModel, enableModel, isDisabled, readDisabledMap } from "switchback-core/state.ts";

describe("manual disable store", () => {
	let dir: string;
	let path: string;

	beforeEach(() => {
		dir = join(tmpdir(), `switchback-disabled-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(dir, { recursive: true });
		path = join(dir, "disabled.json");
	});

	afterEach(() => {
		if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
	});

	it("a missing file reads as empty and nothing is disabled", () => {
		const map = readDisabledMap(path);
		expect(map).toEqual({});
		expect(isDisabled("zai/glm-4.7", map)).toBe(false);
	});

	it("disable stamps the time, persists it, and is idempotent", () => {
		expect(disableModel("zai/glm-4.7", 1_700_000_000_000, path)).toBe(true);
		expect(readDisabledMap(path)).toEqual({ "zai/glm-4.7": 1_700_000_000_000 });
		// A second disable keeps the original stamp (the "since" display must not drift).
		expect(disableModel("zai/glm-4.7", 1_800_000_000_000, path)).toBe(false);
		expect(readDisabledMap(path)["zai/glm-4.7"]).toBe(1_700_000_000_000);
	});

	it("entries never expire on their own", () => {
		disableModel("minimax/plus", 1, path);
		expect(isDisabled("minimax/plus", readDisabledMap(path))).toBe(true);
	});

	it("enable removes one entry and reports whether it existed", () => {
		disableModel("zai/glm-4.7", 5, path);
		disableModel("minimax/plus", 6, path);
		expect(enableModel("zai/glm-4.7", path)).toBe(true);
		expect(Object.keys(readDisabledMap(path))).toEqual(["minimax/plus"]);
		expect(enableModel("zai/glm-4.7", path)).toBe(false);
	});

	it("clear removes every entry and counts what it removed", () => {
		disableModel("a/one", 1, path);
		disableModel("b/two", 2, path);
		expect(clearDisabled(path)).toBe(2);
		expect(readDisabledMap(path)).toEqual({});
		expect(clearDisabled(path)).toBe(0);
	});

	it("rejects a hand-edited file with a non-number value", () => {
		writeFileSync(path, JSON.stringify({ "zai/glm-4.7": "yes" }));
		expect(() => readDisabledMap(path)).toThrow(/non-number value for key "zai\/glm-4\.7"/);
	});

	it("writes atomically, leaving no staging files behind", () => {
		disableModel("zai/glm-4.7", 9, path);
		expect(readdirSync(dir)).toEqual(["disabled.json"]);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ "zai/glm-4.7": 9 });
	});
});
