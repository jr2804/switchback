/**
 * Cross-session blocked-until map persisted to `<piConfigDir>/switchback/blocks.json`.
 *
 * The file is managed by the switchback runtime, not user-edited. Writes are atomic
 * (`writeFileAtomic`, src/atomic-write.ts) so a crash during a write cannot corrupt the map.
 *
 * Path change: prior to v2026.10.5 the file lived at `<cwd>/.pi/switchback.json`.
 * Blocks are account-scoped (a hit on `zai/glm-5.3` 5h is a fact about the
 * account's quota, not the project on disk), so the file moved to the global
 * agent config dir. On first read, if the legacy cwd file is present, it is
 * merged into the new path (per-key max timestamp wins) and then deleted. The
 * merge is a one-time migration; once the legacy file is gone, it is not
 * recreated.
 *
 * Expired entries are pruned lazily on read; the on-disk file is only rewritten when
 * a write actually changes the map.
 */

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic-write.ts";
import { switchbackStateDir } from "./config.ts";
import type { BlockedMap, DisabledMap, ModelId } from "./types.ts";
export type { DisabledMap };

/** Path to the blocked-until map. The new (account-scoped) location. */
export function stateFilePath(): string {
	return join(switchbackStateDir(), "blocks.json");
}

/** Legacy path: project-local. Migrated to the new path on first read. */
function legacyStateFilePath(): string {
	return join(process.cwd(), ".pi", "switchback.json");
}

function readRaw(path: string): BlockedMap {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	if (text.trim().length === 0) return {};
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`switchback: ${path} is not a JSON object`);
	}
	const out: BlockedMap = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			throw new Error(`switchback: ${path} has non-number value for key "${key}"`);
		}
		out[key] = value;
	}
	return out;
}

function writeRaw(path: string, map: BlockedMap): void {
	writeFileAtomic(path, JSON.stringify(map, null, 2));
}

/** Migrate the legacy project-local file into the new account-scoped path. Idempotent. */
function migrateFromLegacy(targetPath: string): void {
	const legacy = legacyStateFilePath();
	if (!existsSync(legacy)) return;
	const legacyMap = readRaw(legacy);
	const targetExists = existsSync(targetPath);
	const targetMap = targetExists ? readRaw(targetPath) : {};
	// Per-key max wins.
	const merged: BlockedMap = { ...targetMap };
	for (const [k, v] of Object.entries(legacyMap)) {
		const cur = merged[k];
		if (cur === undefined || v > cur) merged[k] = v;
	}
	writeRaw(targetPath, merged);
	// Remove the legacy file. Use rmSync (not unlinkSync) for safety on dirs.
	try {
		rmSync(legacy, { force: true });
	} catch {
		// If the legacy file is locked, leave it. The next read will retry the
		// migration; the worst case is a duplicate write that is harmless.
	}
}

/** Read the blocked-until map, dropping entries whose `blocked-until` is in the past. */
export function readBlockedMap(now: number = Date.now(), path: string = stateFilePath()): BlockedMap {
	migrateFromLegacy(path);
	const raw = readRaw(path);
	const live: BlockedMap = {};
	let changed = false;
	for (const [key, ts] of Object.entries(raw)) {
		if (ts > now) {
			live[key] = ts;
		} else {
			changed = true;
		}
	}
	if (changed) writeRaw(path, live);
	return live;
}

/** Check whether a model is currently blocked. */
export function isBlocked(modelId: ModelId, now: number = Date.now(), map: BlockedMap = readBlockedMap(now)): boolean {
	const ts = map[modelId];
	return ts !== undefined && ts > now;
}

/** Mark a model as blocked until `resetAtMs` (or default 5 minutes from `now`). */
export function blockModel(
	modelId: ModelId,
	resetAtMs: number | undefined,
	now: number = Date.now(),
	path: string = stateFilePath(),
): void {
	const map = readRaw(path);
	const ts = resetAtMs ?? now + 5 * 60_000;
	if (map[modelId] === ts) return;
	map[modelId] = ts;
	writeRaw(path, map);
}

/** Remove a model from the blocked map (called on the overflow and no-failure-message paths so a stale block does not persist). */
export function unblockModel(modelId: ModelId, path: string = stateFilePath()): void {
	const map = readRaw(path);
	if (!(modelId in map)) return;
	delete map[modelId];
	writeRaw(path, map);
}

/**
 * Manually disabled models, persisted to `<state dir>/disabled.json`.
 *
 * This is the user's explicit "never route here" list, set and cleared by the
 * `/switchback-disable` and `/switchback-enable` commands. Unlike blocks it has
 * no reset time: a disabled model stays out of every chain until it is enabled
 * again. It lives in the state dir (not switchback.yaml) so regenerating the
 * config - for example re-running the switchback-free skill - cannot silently
 * re-enable a model the user turned off. Values are the epoch-ms disable time,
 * kept so a status display can say since when.
 */
/** Path to the manually-disabled map. */
export function disabledFilePath(): string {
	return join(switchbackStateDir(), "disabled.json");
}

function readDisabledRaw(path: string): DisabledMap {
	return readRaw(path);
}

function writeDisabledRaw(path: string, map: DisabledMap): void {
	writeRaw(path, map);
}

/** Read the manually-disabled map. Entries never expire; only `enableModel` removes them. */
export function readDisabledMap(path: string = disabledFilePath()): DisabledMap {
	return readDisabledRaw(path);
}

/** Check whether a model was manually disabled. Takes the map: callers read it once per decision. */
export function isDisabled(modelId: ModelId, map: DisabledMap): boolean {
	return map[modelId] !== undefined;
}

/** Disable a model. Returns false when it was already disabled. */
export function disableModel(modelId: ModelId, now: number = Date.now(), path: string = disabledFilePath()): boolean {
	const map = readDisabledRaw(path);
	if (map[modelId] !== undefined) return false;
	map[modelId] = now;
	writeDisabledRaw(path, map);
	return true;
}

/** Enable a model again. Returns false when it was not disabled. */
export function enableModel(modelId: ModelId, path: string = disabledFilePath()): boolean {
	const map = readDisabledRaw(path);
	if (!(modelId in map)) return false;
	delete map[modelId];
	writeDisabledRaw(path, map);
	return true;
}

/** Clear the whole list (the `/switchback-enable all` path). Returns how many were removed. */
export function clearDisabled(path: string = disabledFilePath()): number {
	const map = readDisabledRaw(path);
	const count = Object.keys(map).length;
	if (count === 0) return 0;
	writeDisabledRaw(path, {});
	return count;
}

/**
 * Manually pinned model per virtual model, persisted to
 * `<piConfigDir>/switchback/pin.json`. A pin is the user's explicit "route here"
 * override (set by `/switchback-next`); it wins over stickiness and preference
 * for as long as the pinned model is usable (effective and not blocked). Null
 * removes the pin. Managed by the runtime; atomic writes like blocks.json.
 */
export type PinMap = Record<string, ModelId | null>;

/** Path to the pin map. */
export function pinFilePath(): string {
	return join(switchbackStateDir(), "pin.json");
}

function readPinRaw(path: string): PinMap {
	if (!existsSync(path)) return {};
	const text = readFileSync(path, "utf8");
	if (text.trim().length === 0) return {};
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`switchback: ${path} is not a JSON object`);
	}
	const out: PinMap = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (value === null) out[key] = null;
		else if (typeof value === "string") out[key] = value;
		else throw new Error(`switchback: ${path} has a non-string pin for "${key}"`);
	}
	return out;
}

function writePinRaw(path: string, map: PinMap): void {
	writeFileAtomic(path, JSON.stringify(map, null, 2));
}

/** Read the whole pin map (mostly for status displays). */
export function readPinMap(path: string = pinFilePath()): PinMap {
	return readPinRaw(path);
}

/** The pinned physical model for a virtual model, when one is set. */
export function getPinnedModel(virtualId: string, path: string = pinFilePath()): ModelId | undefined {
	const pin = readPinRaw(path)[virtualId];
	return pin === undefined ? undefined : (pin ?? undefined);
}

/** Set (or clear, with null) the pinned physical model for a virtual model. */
export function setPinnedModel(virtualId: string, model: ModelId | null, path: string = pinFilePath()): void {
	const map = readPinRaw(path);
	if (model === null) delete map[virtualId];
	else map[virtualId] = model;
	writePinRaw(path, map);
}
