/**
 * The one atomic file writer behind every switchback store.
 *
 * A store is written to a temp file in the destination directory and then
 * renamed over the destination, so a reader (another pi session, a crashed
 * run's leftovers) never sees a half-written file.
 *
 * Two things the shape has to get right on Windows, where the rename is not
 * atomic for free:
 *
 * - **The temp name is per write, not per file.** A fixed `<path>.tmp` makes
 *   two writers in one directory (two pi sessions sharing
 *   `<piConfigDir>/switchback/`) fight over the same staging file: whichever
 *   renames first moves the *other's* bytes away, and the loser then fails on a
 *   source that no longer exists.
 * - **The rename is retried with a real backoff.** While anything else holds
 *   the destination - an indexer, an antivirus scanner, another process - Windows
 *   refuses the rename and Node reports `EPERM`. That window is short, so an
 *   immediate retry loses the race: with two back-to-back attempts the crash
 *   store failed about one full test run in three (measured 2026-10-09), and the
 *   retry that existed then slept zero milliseconds between attempts. The budget
 *   below is 10…320 ms.
 *
 * The callers own their own error vocabulary (`CrashError`, `SecretsError`,
 * `ConfigError`); this module reports a failure as `AtomicWriteError` with the
 * last filesystem error as its `cause`.
 */

import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Rename attempts before a write is declared failed: 6 backoffs, 10…320 ms. */
const RENAME_ATTEMPTS = 7;

/** First backoff; each further attempt doubles it (10, 20, 40, 80, 160, 320). */
const RENAME_BACKOFF_MS = 10;

/** Per-process counter, so two writes in one process never share a temp path. */
let tmpSeq = 0;

/** A store write that could not be completed; `cause` is the last fs error. */
export class AtomicWriteError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`switchback: atomic: ${message}`, options);
		this.name = "AtomicWriteError";
	}
}

/** The staging path the next write to `path` uses. Distinct on every call. */
export function atomicTmpPath(path: string): string {
	tmpSeq += 1;
	return `${path}.${process.pid}.${tmpSeq}.tmp`;
}

/**
 * Write `contents` to `path` atomically, creating the parent directory if
 * needed. Throws {@link AtomicWriteError} - and leaves no temp file behind -
 * when the rename still fails after the retry budget.
 */
export function writeFileAtomic(path: string, contents: string): void {
	const tmp = atomicTmpPath(path);
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tmp, contents, "utf8");
		let lastError: unknown = undefined;
		for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
			try {
				renameSync(tmp, path);
				return;
			} catch (error) {
				lastError = error;
				if (attempt < RENAME_ATTEMPTS - 1) sleep(RENAME_BACKOFF_MS * 2 ** attempt);
			}
		}
		throw new AtomicWriteError(`could not rename ${tmp} onto ${path} after ${RENAME_ATTEMPTS} attempts`, {
			cause: lastError,
		});
	} catch (error) {
		rmSync(tmp, { force: true });
		throw error instanceof AtomicWriteError
			? error
			: new AtomicWriteError(`could not write ${path}`, { cause: error });
	}
}

/** Block the calling thread. Stores are written from sync code, so there is no loop to await. */
function sleep(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
