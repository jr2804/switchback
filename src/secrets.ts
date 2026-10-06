/**
 * Encrypted-at-rest secret store at `<piConfigDir>/switchback/secrets.json`.
 *
 * Holds the API keys that YAML references as `secret:<name>` (a key-bearing
 * config field such as a classifier `apiKey`), so a credential never lives in
 * a config file and never reaches the disk in plaintext.
 *
 * Encryption boundary: Windows DPAPI (CryptProtectData, CurrentUser scope).
 * Node has no built-in DPAPI, so the round-trip runs through a child
 * `powershell.exe -NoProfile -Command` call driving
 * [System.Security.Cryptography.ProtectedData]. The blob is bound to the
 * Windows account plus machine: no passphrase to manage, and another account
 * on the same box cannot decrypt it. There is deliberately NO plaintext
 * fallback - if DPAPI is unavailable (non-Windows host, powershell.exe
 * missing, ProtectedData unloadable) the operation throws SecretsError
 * instead of writing the value anywhere.
 *
 * Plaintext handling: the value travels to the child over stdin, base64-wrapped
 * (ASCII survives any console codepage; argv would be visible in a process
 * listing) and comes back the same way, base64-wrapped so no error output can
 * ever contain the raw value. Nothing here logs; error messages carry the
 * entry name and powershell diagnostics, never the value.
 *
 * File format: `{ "version": 1, "entries": { "<name>": "<dpapi base64>" } }`,
 * written atomically (tmp + rename, the state.ts pattern). A file that cannot
 * be parsed or does not have that shape is quarantined to
 * `secrets.json.corrupt.<ts>` (the crashes.ts pattern) and the store starts
 * fresh - except the rename failure itself is NOT swallowed (unlike crashes):
 * these blobs are irreplaceable, so a failure to move the old file surfaces
 * as a SecretsError rather than silently overwriting it. A parseable file
 * carrying a different `version` is incompatible, not corrupt: it throws and
 * is left untouched.
 *
 * Tests inject the two DPAPI functions (`createSecretStore(dpapi?)`) so the
 * suite never spawns powershell; one opt-in test drives the real child
 * process (SWITCHBACK_SECRETS_LIVE=1).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { piSwitchbackDir } from "./config.ts";

/** Current on-disk format version of secrets.json. */
const SECRETS_VERSION = 1;

/** One powershell round-trip is bounded so a hung child cannot wedge the caller. */
const PS_TIMEOUT_MS = 15_000;

const POWERSHELL_EXE = "powershell.exe";

/** ASCII-only base64. `+` (not `*`) rejects empty output: a silent no-op run must not look like a blob. */
const BASE64_OUTPUT = /^[A-Za-z0-9+/]+={0,2}$/;

export class SecretsError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(`switchback: secrets: ${message}`, options);
		this.name = "SecretsError";
	}
}

/**
 * The two DPAPI operations the store needs, injected so tests can run without
 * powershell. Implementations are all-or-nothing: on failure they throw.
 * There is no best-effort plaintext path to fall back to.
 */
export interface Dpapi {
	/** Encrypt a UTF-8 string to an opaque base64 blob. */
	protect(value: string): string;
	/** Decrypt a blob produced by protect(). Throws when it cannot be read. */
	unprotect(blob: string): string;
}

// Both scripts read an ASCII base64 payload from stdin (never argv, never raw
// bytes) and write an ASCII base64 result to stdout, so neither direction
// depends on the console codepage. $ErrorActionPreference makes Add-Type
// failures terminating (non-zero exit) instead of continuing into a type
// error with exit 0.
const PROTECT_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Security",
	"$plain = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())",
	"$blob = [System.Security.Cryptography.ProtectedData]::Protect($plain, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
	"[Console]::Out.Write([Convert]::ToBase64String($blob))",
].join("; ");

const UNPROTECT_SCRIPT = [
	"$ErrorActionPreference = 'Stop'",
	"Add-Type -AssemblyName System.Security",
	"$blob = [Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim())",
	"$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($blob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
	"[Console]::Out.Write([Convert]::ToBase64String($plain))",
].join("; ");

/** The subset of a child_process spawn failure this module reports on. */
interface SpawnFailure {
	code?: string;
	killed?: boolean;
	status?: number | null;
	stderr?: string | Uint8Array;
}

/**
 * Turn a spawn/exit failure into a SecretsError with actionable diagnostics.
 * The stderr tail is safe to surface: neither script ever references its
 * stdin payload in an error path, so the value cannot appear there.
 */
function describeSpawnFailure(error: unknown): SecretsError {
	const info = (typeof error === "object" && error !== null ? error : {}) as SpawnFailure;
	if (info.code === "ENOENT") {
		return new SecretsError(
			"powershell.exe not found - the encrypted store needs Windows DPAPI (CryptProtectData), which is unavailable here; refusing any plaintext fallback",
			{ cause: error },
		);
	}
	if (info.killed === true) {
		return new SecretsError(`powershell DPAPI call exceeded ${PS_TIMEOUT_MS}ms and was killed`, { cause: error });
	}
	const stderr = typeof info.stderr === "string" ? info.stderr : info.stderr !== undefined ? new TextDecoder().decode(info.stderr) : "";
	const tail = stderr
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0)
		.slice(-4)
		.join(" ")
		.slice(0, 400);
	const exit = typeof info.status === "number" ? ` (exit ${info.status})` : "";
	return new SecretsError(`DPAPI round-trip failed${exit}${tail.length > 0 ? `: ${tail}` : " with no diagnostics"}`, { cause: error });
}

/**
 * One powershell round-trip: payload on stdin, ASCII base64 on stdout.
 * Output is validated rather than trusted - a codepage or PowerShell-version
 * surprise must fail loudly here, not produce a half-read blob. The output
 * itself is never echoed into the error (unprotect output is base64(plaintext)).
 */
function runPowerShell(script: string, payload: string): string {
	let stdout: string;
	try {
		stdout = execFileSync(
			POWERSHELL_EXE,
			["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
			{
				input: payload,
				encoding: "utf8",
				windowsHide: true,
				timeout: PS_TIMEOUT_MS,
			},
		);
	} catch (error) {
		throw describeSpawnFailure(error);
	}
	const out = stdout.replace(/^\uFEFF/, "").trim();
	if (!BASE64_OUTPUT.test(out)) {
		throw new SecretsError("powershell DPAPI round-trip produced empty or non-base64 output (encoding or PowerShell version problem)");
	}
	return out;
}

/** Real DPAPI round-trip through a powershell.exe child process (Windows only). */
export const powershellDpapi: Dpapi = {
	protect(value: string): string {
		return runPowerShell(PROTECT_SCRIPT, Buffer.from(value, "utf8").toString("base64"));
	},
	unprotect(blob: string): string {
		const plainBase64 = runPowerShell(UNPROTECT_SCRIPT, blob);
		return Buffer.from(plainBase64, "base64").toString("utf8");
	},
};

/** Path to the encrypted store inside the agent config dir. */
export function secretsFilePath(): string {
	return join(piSwitchbackDir(), "secrets.json");
}

/** On-disk shape. Every value is a DPAPI blob; plaintext never lands here. */
interface SecretsFile {
	version: number;
	entries: Record<string, string>;
}

function emptyStore(): SecretsFile {
	return { version: SECRETS_VERSION, entries: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Move an unreadable file aside so the store can start fresh. Unlike
 * crashes.ts this does NOT swallow a rename failure: these blobs cannot be
 * re-encrypted from anywhere else, so an inability to preserve the old file
 * is a loud SecretsError, not a silent overwrite.
 */
function quarantineCorruptFile(path: string): void {
	try {
		renameSync(path, `${path}.corrupt.${Date.now()}`);
	} catch (error) {
		throw new SecretsError(`cannot quarantine corrupt store ${path}`, { cause: error });
	}
}

function readStore(path: string): SecretsFile {
	if (!existsSync(path)) return emptyStore();
	const text = readFileSync(path, "utf8");
	if (text.trim().length === 0) return emptyStore();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		quarantineCorruptFile(path);
		return emptyStore();
	}
	if (!isRecord(parsed)) {
		quarantineCorruptFile(path);
		return emptyStore();
	}
	const version = parsed["version"];
	if (typeof version === "number" && version !== SECRETS_VERSION) {
		// Incompatible, not corrupt: leave it for the build that wrote it.
		throw new SecretsError(`store has version ${version}, this build reads version ${SECRETS_VERSION} - leaving the file untouched`);
	}
	if (typeof version !== "number") {
		quarantineCorruptFile(path);
		return emptyStore();
	}
	const entries = parsed["entries"];
	if (!isRecord(entries)) {
		quarantineCorruptFile(path);
		return emptyStore();
	}
	const clean: Record<string, string> = {};
	for (const [name, blob] of Object.entries(entries)) {
		if (typeof blob !== "string") {
			quarantineCorruptFile(path);
			return emptyStore();
		}
		clean[name] = blob;
	}
	return { version: SECRETS_VERSION, entries: clean };
}

function writeStore(path: string, store: SecretsFile): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
	renameSync(tmp, path);
}

function assertName(name: string): void {
	if (name.trim().length === 0) {
		throw new SecretsError("secret name must be a non-empty string");
	}
}

/** The store: named entries, values only ever held in memory or as DPAPI blobs. */
export interface SecretStore {
	/** Encrypt and persist `value` under `name` (overwrites an existing entry). */
	set(name: string, value: string): void;
	/** Decrypt and return the value; undefined when the name is unknown. */
	get(name: string): string | undefined;
	/** Remove an entry. Idempotent: a missing name is a no-op. */
	delete(name: string): void;
	/** Stored names only - never values. */
	list(): string[];
}

/**
 * Create a store. `dpapi` defaults to the real powershell round-trip; tests
 * inject a stand-in so they never spawn a child process. `path` defaults to
 * `<piConfigDir>/switchback/secrets.json`.
 */
export function createSecretStore(dpapi: Dpapi = powershellDpapi, path: string = secretsFilePath()): SecretStore {
	return {
		set(name: string, value: string): void {
			assertName(name);
			if (value.length === 0) {
				throw new SecretsError(`secret "${name}" must have a non-empty value`);
			}
			// Encrypt before touching the file: if DPAPI is unavailable the call
			// throws here and nothing has been written anywhere.
			const blob = dpapi.protect(value);
			const store = readStore(path);
			store.entries[name] = blob;
			writeStore(path, store);
		},
		get(name: string): string | undefined {
			assertName(name);
			const store = readStore(path);
			const blob = store.entries[name];
			if (blob === undefined) return undefined;
			try {
				return dpapi.unprotect(blob);
			} catch (error) {
				throw new SecretsError(`cannot decrypt secret "${name}" - stored for another Windows account, or the blob is damaged`, {
					cause: error,
				});
			}
		},
		delete(name: string): void {
			assertName(name);
			const store = readStore(path);
			if (!(name in store.entries)) return;
			delete store.entries[name];
			writeStore(path, store);
		},
		list(): string[] {
			return Object.keys(readStore(path).entries);
		},
	};
}
