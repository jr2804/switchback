/**
 * Cross-session blocked-until map persisted to `<piConfigDir>/switchback/blocks.json`.
 *
 * The file is managed by the switchback runtime, not user-edited. Writes are atomic
 * (write to a temp file, then rename) so a crash during a write cannot corrupt the map.
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

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piSwitchbackDir } from "./config.ts";
import type { BlockedMap, ModelId } from "./types.ts";

/** Path to the blocked-until map. The new (account-scoped) location. */
export function stateFilePath(): string {
	return join(piSwitchbackDir(), "blocks.json");
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
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
	renameSync(tmp, path);
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
