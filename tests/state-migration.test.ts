/**
 * Tests for the cwd-to-agent-dir migration of the blocked-until map.
 *
 * Before v2026.10.5 the file lived at `<cwd>/.pi/switchback.json`. The file moved
 * to `<piConfigDir>/switchback/blocks.json` because blocks are account-scoped
 * (a 5h hit is a fact about the account, not the project on disk). On first
 * read of the new path, if a legacy cwd file is present, it is merged in
 * (per-key max timestamp wins) and then deleted.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { blockModel, isBlocked, readBlockedMap, stateFilePath } from "../src/state.ts";

let tmpDir: string;
let originalAgentDir: string | undefined;
let originalCwd: string;

beforeEach(() => {
	originalCwd = process.cwd();
	originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
	tmpDir = join(tmpdir(), `switchback-state-migration-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
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

describe("state.ts migration from legacy cwd path to agent dir", () => {
	const legacyPath = () => join(tmpDir, ".pi", "switchback.json");
	const newPath = () => stateFilePath(); // resolves to <agentDir>/switchback/blocks.json

	it("migrates a legacy file to the new path on first read", () => {
		// Pre-condition: a legacy file exists with one block, no new file.
		mkdirSync(dirname(legacyPath()), { recursive: true });
		writeFileSync(legacyPath(), JSON.stringify({ "zai/glm-5.3": 1_000_000 }));
		expect(existsSync(newPath())).toBe(false);

		// Trigger migration via readBlockedMap. Use a `now` smaller than the
		// migrated timestamp so the entry is not pruned as "expired" on read.
		const map = readBlockedMap(500_000);
		expect(map["zai/glm-5.3"]).toBe(1_000_000);
		expect(existsSync(newPath())).toBe(true);
		// Legacy file is removed.
		expect(existsSync(legacyPath())).toBe(false);
	});

	it("merges with per-key max timestamp when both legacy and new files exist", () => {
		// New file has a later timestamp for ollama-cloud; legacy has the only
		// zai entry. Merged result keeps max.
		mkdirSync(join(tmpDir, "switchback"), { recursive: true });
		writeFileSync(newPath(), JSON.stringify({ "ollama-cloud/pro": 5_000_000 }));
		mkdirSync(dirname(legacyPath()), { recursive: true });
		writeFileSync(legacyPath(), JSON.stringify({ "zai/glm-5.3": 1_000_000, "ollama-cloud/pro": 4_000_000 }));

		const map = readBlockedMap(0);
		expect(map["ollama-cloud/pro"]).toBe(5_000_000); // max wins
		expect(map["zai/glm-5.3"]).toBe(1_000_000);
		expect(existsSync(legacyPath())).toBe(false);
	});

	it("legacy-write side: blockModel writes only to the new path", () => {
		blockModel("zai/glm-5.3", 1_000_000);
		expect(existsSync(legacyPath())).toBe(false);
		expect(existsSync(newPath())).toBe(true);
		const map = JSON.parse(readFileSync(newPath(), "utf8")) as Record<string, number>;
		expect(map["zai/glm-5.3"]).toBe(1_000_000);
	});

	it("isBlocked is true for migrated entries", () => {
		mkdirSync(dirname(legacyPath()), { recursive: true });
		writeFileSync(legacyPath(), JSON.stringify({ "zai/glm-5.3": 1_000_000 }));
		expect(isBlocked("zai/glm-5.3", 500_000)).toBe(true);
	});

	it("migration is idempotent: a second read with no legacy file does nothing", () => {
		mkdirSync(dirname(legacyPath()), { recursive: true });
		writeFileSync(legacyPath(), JSON.stringify({ "zai/glm-5.3": 1_000_000 }));
		readBlockedMap(2_000_000);
		const firstWrite = readFileSync(newPath(), "utf8");
		readBlockedMap(2_000_000);
		const secondWrite = readFileSync(newPath(), "utf8");
		expect(firstWrite).toBe(secondWrite);
	});
});
