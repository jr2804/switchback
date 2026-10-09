/**
 * The atomic store writer: a staging path per write, and a rename that
 * outlasts a Windows handle on the destination.
 *
 * The Windows test is the point of the module. It reproduces the failure the
 * crash store hit under a full parallel suite run - `EPERM: operation not
 * permitted, rename` while something else holds the destination open - by
 * holding the destination from a PowerShell child, and shows the retry budget
 * surviving a hold that two immediate rename attempts do not.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicTmpPath, writeFileAtomic, AtomicWriteError } from "../src/atomic-write.ts";

let tmpDir: string;

beforeEach(() => {
	tmpDir = join(tmpdir(), `switchback-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Open `path` from a child process without FILE_SHARE_DELETE for `holdMs`, then
 * release it. Windows refuses a rename over an open destination, so every
 * `renameSync` aimed at `path` fails with EPERM until the child closes it.
 *
 * `held` resolves with the child's own clock at the moment it took the handle,
 * so the test can measure how much of the hold is left before it commits to the
 * write under test.
 */
function holdDestination(path: string, holdMs: number): { held: Promise<{ at: number }>; done: Promise<void> } {
	const literal = path.replace(/'/g, "''");
	const script = [
		"$sw=[System.Diagnostics.Stopwatch]::StartNew()",
		`$fs=[System.IO.File]::Open('${literal}','Open','Read','ReadWrite')`,
		"[Console]::Out.WriteLine('held '+$sw.ElapsedMilliseconds)",
		"[Console]::Out.Flush()",
		`[System.Threading.Thread]::Sleep(${holdMs})`,
		"$fs.Dispose()",
	].join(";");
	const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]);
	let announceHeld: (at: number) => void = () => {};
	const held = new Promise<{ at: number }>((resolve) => {
		announceHeld = resolve;
	});
	child.stdout?.on("data", (chunk: Buffer) => {
		const match = /held (\d+)/.exec(chunk.toString());
		if (match?.[1] !== undefined) announceHeld(Number(match[1]));
	});
	const done = new Promise<void>((resolve, reject) => {
		child.on("error", reject);
		child.on("close", () => resolve());
	});
	return { held, done };
}

describe.runIf(process.platform === "win32")("writeFileAtomic — destination held open by another process", () => {
	const HOLD_MS = 250;
	/** The hold must still cover this much when the write starts, or the write proves nothing. */
	const REQUIRED_HOLD_MS = 80;

	it("completes the write where two immediate rename attempts would fail", async () => {
		const path = join(tmpDir, "store.json");
		writeFileSync(path, "before", "utf8");

		// A late 'held' signal can hand us a hold that is already spent (the
		// suite runs this file beside 19 others), so the reproduction is retried
		// rather than assumed. Each round proves the EPERM window is real and
		// still wide enough to defeat an immediate retry.
		let reproduced = false;
		for (let round = 0; round < 4 && !reproduced; round++) {
			const { held, done } = holdDestination(path, HOLD_MS);
			const { at } = await held;
			const probe = atomicTmpPath(path);
			writeFileSync(probe, "probe", "utf8");
			let probeError: NodeJS.ErrnoException | undefined;
			try {
				renameSync(probe, path);
			} catch (error) {
				probeError = error as NodeJS.ErrnoException;
			}
			// Either the hold is live (EPERM) or it has already lapsed (no
			// error). Any other failure is not a reproduction and must not be
			// mistaken for one.
			expect(probeError === undefined || probeError.code === "EPERM").toBe(true);
			if (probeError === undefined) {
				await done;
				continue;
			}
			// Thread.Sleep can overshoot, which only lengthens the hold; requiring
			// sleep time left is therefore the conservative direction.
			const remaining = HOLD_MS - (Date.now() - at);
			if (remaining < REQUIRED_HOLD_MS) {
				await done;
				continue;
			}
			writeFileAtomic(path, "after");
			expect(readFileSync(path, "utf8")).toBe("after");
			await done;
			reproduced = true;
		}
		expect(reproduced).toBe(true);
	}, 30_000);
});

describe("writeFileAtomic — staging", () => {
	it("stages through a fresh path on every write and leaves no staging file behind", () => {
		const path = join(tmpDir, "store.json");
		const first = atomicTmpPath(path);
		const second = atomicTmpPath(path);
		expect(first).not.toBe(second);
		expect(first).toContain(`${process.pid}`);

		writeFileAtomic(path, "one");
		writeFileAtomic(path, "two");
		expect(readFileSync(path, "utf8")).toBe("two");
		expect(readdirSync(tmpDir)).toEqual(["store.json"]);
	});

	it("reports an unwritable destination as AtomicWriteError and cleans up", () => {
		const blocker = join(tmpDir, "blocker");
		writeFileSync(blocker, "not a directory", "utf8");
		let caught: unknown;
		try {
			writeFileAtomic(join(blocker, "store.json"), "payload");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(AtomicWriteError);
		expect((caught as AtomicWriteError).cause).toBeInstanceOf(Error);
		expect(readdirSync(tmpDir)).toEqual(["blocker"]);
	});
});
