/**
 * Cross-session crash dedup store at `<piConfigDir>/switchback/crashes.json`.
 *
 * The store records every failed request the router sees, classified or not,
 * keyed by sha256 of the raw error bytes (the pi-rendered form, not anything
 * derived from it). Its job is twofold:
 *
 *   1. Corpus growth. Every new shape the user encounters ends up in the
 *      store, even when no classifier is configured. The corpus is no longer
 *      limited to "what was passively captured from past session files" - it
 *      grows during normal use.
 *
 *   2. Tier 2b annotation cache. When the user runs `/switchback-annotate
 *      <hash> <class> [note]` on a stored entry, the annotation is persisted
 *      with the entry. classifyError checks for an annotated entry BEFORE
 *      calling the classifier and returns the annotated class directly
 *      (source "annotation", resetAtMs undefined -> default block). Entries
 *      with only a classifier verdict NEVER short-circuit - the user must
 *      confirm those exact bytes for the cache to fire. This is the no-
 *      heuristics rule made explicit: the cache is a store of user-confirmed
 *      decisions, not a code-side inference.
 *
 * The store is machine-local (in the agent config dir, not in the repo),
 * so any personal data in the raw sample is contained to the user's
 * machine. The personal-data scrub gate applies before anything is
 * promoted into the repo (no fixtures or seeds are derived from this
 * file at release time).
 *
 * Atomic write: `writeFileAtomic` (src/atomic-write.ts).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { piSwitchbackDir } from "./config.ts";
import type { ClassifiedError, ErrorClass, ErrorScope } from "./types.ts";
import type { NoClassifierReason } from "./classify.ts";

/** What the router did about a particular failure. */
export type CrashAction = "blind-cycle" | "blocked+advanced" | "stuck-stayed";

/** A classifier verdict (with the prompt version that produced it). */
export interface CrashVerdict {
	class: ErrorClass;
	scope: ErrorScope;
	promptVersion: string;
}

/** A user-annotated class for a stored crash. The Tier 2b cache key. */
export interface CrashAnnotation {
	class: ErrorClass;
	note: string;
	at: number;
}

/** One stored crash entry. */
export interface CrashEntry {
	sample: string;
	provider: string;
	model: string;
	first: number;
	last: number;
	count: number;
	/** Classifier verdict; null when the recording happened on the no-classifier path. */
	verdict: CrashVerdict | null;
	noClassifierReason?: NoClassifierReason;
	action: CrashAction;
	/** User annotation. When present, the entry short-circuits classifyError on the next hit. */
	annotated?: CrashAnnotation;
	verdictHistory: {
		at: number;
		verdict: CrashVerdict | null;
		noClassifierReason?: NoClassifierReason;
		action: CrashAction;
	}[];
}

export type CrashMap = Record<string, CrashEntry>;

/** Path to the crash store inside the agent config dir. */
export function crashesFilePath(): string {
	return join(piSwitchbackDir(), "crashes.json");
}

/** sha256 of the raw error bytes. Used as the dedup key. */
export function hashSample(raw: string): string {
	return createHash("sha256").update(raw, "utf8").digest("hex");
}

/** First 8 hex chars of the sha256. Used in command output. */
export function shortHash(hash: string): string {
	return hash.slice(0, 8);
}

function readRaw(path: string): CrashMap {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	if (text.trim().length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		// Corrupt file (invalid JSON) - back it up and start fresh so the user
		// can recover manually if they want. Never throw on a store read; the
		// router must keep working even if the store is broken.
		quarantineCorruptFile(path);
		return {};
	}
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		quarantineCorruptFile(path);
		return {};
	}
	return parsed as CrashMap;
}

function quarantineCorruptFile(path: string): void {
	const backup = `${path}.corrupt.${Date.now()}`;
	try {
		renameSync(path, backup);
	} catch {
		// If even the rename fails, swallow - the empty-map fallback will let
		// the next write overwrite the bad file.
	}
}

function writeRaw(path: string, map: CrashMap): void {
	try {
		writeFileAtomic(path, JSON.stringify(map, null, 2));
	} catch (error) {
		throw new CrashError(`cannot write crash store ${path}`, { cause: error });
	}
}

/** Read the full crash store. Returns an empty map if the file is missing or corrupt. */
export function readCrashMap(path: string = crashesFilePath()): CrashMap {
	return readRaw(path);
}

/** Parameters for `recordCrash`. */
export interface RecordCrashInput {
	raw: string;
	provider: string;
	model: string;
	now: number;
	action: CrashAction;
	verdict: ClassifiedError | null;
	noClassifierReason?: NoClassifierReason;
	promptVersion: string;
}

/**
 * Record one crash. Updates the existing entry's count/last, or creates a new
 * one. Always appends to verdictHistory. Atomic write.
 */
export function recordCrash(input: RecordCrashInput, path: string = crashesFilePath()): CrashEntry {
	const map = readRaw(path);
	const hash = hashSample(input.raw);
	const existing = map[hash];
	const sampleForStore =
		input.raw.length > 4_000
			? `${input.raw.slice(0, 4_000)}...[truncated ${input.raw.length - 4_000} chars]`
			: input.raw;
	const verdict: CrashVerdict | null = input.verdict
		? { class: input.verdict.class, scope: input.verdict.scope, promptVersion: input.promptVersion }
		: null;
	const historyEntry = {
		at: input.now,
		verdict,
		...(input.noClassifierReason ? { noClassifierReason: input.noClassifierReason } : {}),
		action: input.action,
	};
	if (existing === undefined) {
		const entry: CrashEntry = {
			sample: sampleForStore,
			provider: input.provider,
			model: input.model,
			first: input.now,
			last: input.now,
			count: 1,
			verdict,
			...(input.noClassifierReason ? { noClassifierReason: input.noClassifierReason } : {}),
			action: input.action,
			verdictHistory: [historyEntry],
		};
		map[hash] = entry;
		writeRaw(path, map);
		return entry;
	}
	existing.last = input.now;
	existing.count += 1;
	existing.action = input.action;
	if (verdict !== null) {
		existing.verdict = verdict;
		delete existing.noClassifierReason;
	} else if (input.noClassifierReason !== undefined) {
		existing.noClassifierReason = input.noClassifierReason;
		existing.verdict = null;
	}
	existing.verdictHistory.push(historyEntry);
	// Keep history bounded so the file does not grow unbounded.
	if (existing.verdictHistory.length > 50) {
		existing.verdictHistory = existing.verdictHistory.slice(-50);
	}
	writeRaw(path, map);
	return existing;
}

/** Look up a crash by exact sha256. Returns undefined if not present. */
export function lookupCrash(raw: string, path: string = crashesFilePath()): CrashEntry | undefined {
	const map = readRaw(path);
	return map[hashSample(raw)];
}

/** Look up a crash by short-hash prefix. Throws when ambiguous or unknown. */
export function findCrashByShortHash(
	shortHashValue: string,
	path: string = crashesFilePath(),
): { hash: string; entry: CrashEntry } {
	const map = readRaw(path);
	const matches: { hash: string; entry: CrashEntry }[] = [];
	for (const [hash, entry] of Object.entries(map)) {
		if (hash.startsWith(shortHashValue)) matches.push({ hash, entry });
	}
	if (matches.length === 0) throw new CrashError(`no crash with short-hash prefix "${shortHashValue}"`);
	if (matches.length > 1)
		throw new CrashError(`ambiguous short-hash prefix "${shortHashValue}": ${matches.length} matches`);
	return matches[0]!;
}

/** Annotate a crash with a user-confirmed class. Tier 2b cache. */
export function annotateCrash(
	shortHashValue: string,
	klass: ErrorClass,
	note: string,
	now: number = Date.now(),
	path: string = crashesFilePath(),
): CrashEntry {
	const map = readRaw(path);
	const matches: string[] = [];
	for (const hash of Object.keys(map)) {
		if (hash.startsWith(shortHashValue)) matches.push(hash);
	}
	if (matches.length === 0) throw new CrashError(`no crash with short-hash prefix "${shortHashValue}"`);
	if (matches.length > 1)
		throw new CrashError(`ambiguous short-hash prefix "${shortHashValue}": ${matches.length} matches`);
	const hash = matches[0]!;
	const entry = map[hash]!;
	entry.annotated = { class: klass, note, at: now };
	writeRaw(path, map);
	return entry;
}

const VALID_ANNOTATION_CLASSES: ReadonlySet<ErrorClass> = new Set<ErrorClass>([
	"quota",
	"auth",
	"transient",
	"overflow",
	"unknown",
]);

export function isValidAnnotationClass(value: string): value is ErrorClass {
	return VALID_ANNOTATION_CLASSES.has(value as ErrorClass);
}

export class CrashError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`switchback: crashes: ${message}`, options);
		this.name = "CrashError";
	}
}
