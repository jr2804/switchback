/**
 * Config-file watcher tests: hand-edits to switchback.yaml (or an overlay)
 * republish the selector entries without a restart; unrelated files are
 * ignored and the stop function silences the watcher.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { watchConfigFiles } from "opencode-switchback";

let tmpDir: string;
let stops: Array<() => void>;
let originalCwd: string;

function fakeCtx() {
	return {
		provider: { reload: vi.fn(async () => {}) },
		model: { reload: vi.fn(async () => {}) },
	} as unknown as Parameters<typeof watchConfigFiles>[0];
}

const waitFor = async (cond: () => boolean): Promise<void> => {
	for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
};

beforeEach(() => {
	originalCwd = process.cwd();
	tmpDir = join(tmpdir(), `switchback-watch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env["SWITCHBACK_CONFIG_DIR"] = tmpDir;
	stops = [];
	process.chdir(tmpDir);
});

afterEach(() => {
	for (const stop of stops) stop();
	process.chdir(originalCwd);
	delete process.env["SWITCHBACK_CONFIG_DIR"];
	if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("watchConfigFiles", () => {
	it("republishes after a hand-edit to switchback.yaml", async () => {
		writeFileSync(join(tmpDir, "switchback.yaml"), "models: []\n");
		const ctx = fakeCtx();
		stops.push(watchConfigFiles(ctx));
		writeFileSync(join(tmpDir, "switchback.yaml"), "models: []\n# touch\n");
		await waitFor(() => (ctx.provider.reload as ReturnType<typeof vi.fn>).mock.calls.length > 0);
		expect(ctx.provider.reload).toHaveBeenCalled();
		expect(ctx.model.reload).toHaveBeenCalled();
	});

	it("republishes for an overlay edit and ignores unrelated files", async () => {
		writeFileSync(join(tmpDir, "switchback.yaml"), "models: []\n");
		const ctx = fakeCtx();
		stops.push(watchConfigFiles(ctx));
		writeFileSync(join(tmpDir, "notes.txt"), "hello\n");
		await new Promise((r) => setTimeout(r, 1100));
		expect(ctx.provider.reload).not.toHaveBeenCalled();
		writeFileSync(join(tmpDir, "switchback.oc.yaml"), "models: []\n");
		await waitFor(() => (ctx.provider.reload as ReturnType<typeof vi.fn>).mock.calls.length > 0);
		expect(ctx.provider.reload).toHaveBeenCalled();
	});

	it("the stop function silences further events", async () => {
		writeFileSync(join(tmpDir, "switchback.yaml"), "models: []\n");
		const ctx = fakeCtx();
		const stop = watchConfigFiles(ctx);
		stop();
		writeFileSync(join(tmpDir, "switchback.yaml"), "models: []\n# touch\n");
		await new Promise((r) => setTimeout(r, 1100));
		expect(ctx.provider.reload).not.toHaveBeenCalled();
	});
});
