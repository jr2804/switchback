/**
 * Tests for the encrypted secret store (src/secrets.ts).
 *
 * Hermetic: every test runs against a temp PI_CODING_AGENT_DIR, and the DPAPI
 * functions are injected (mockDpapi) so the suite never spawns powershell.
 * The invariants under test: round-trip / delete / list, corrupt-file
 * quarantine, incompatible-version refusal, and - the security core - that
 * the plaintext never appears in the bytes on disk or in any error message.
 *
 * One opt-in test drives the real powershell child process end to end:
 *   SWITCHBACK_SECRETS_LIVE=1 npx vitest run tests/secrets.test.ts
 *
 * Test values are synthetic sentinels, never real credentials, so an
 * assertion diff can never leak a key.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createSecretStore, secretsFilePath, SecretsError, type Dpapi } from "../src/secrets.ts";
import { piSwitchbackDir } from "../src/config.ts";

const SECRET = "sk-switchback-TESTVALUE-42-not-a-real-key";
const OTHER_SECRET = "sk-switchback-TESTVALUE-99-not-a-real-key";

/** Stand-in backend: clearly-marked base64, so on-disk bytes are obviously not plaintext. */
const mockDpapi: Dpapi = {
	protect(value: string): string {
		return `enc:${Buffer.from(value, "utf8").toString("base64")}`;
	},
	unprotect(blob: string): string {
		const match = /^enc:([A-Za-z0-9+/=]+)$/.exec(blob);
		if (match === null || match[1] === undefined) throw new SecretsError("mock backend: not an encrypted blob");
		return Buffer.from(match[1], "base64").toString("utf8");
	},
};

/** Backend that models DPAPI being unavailable: it throws, as the real one must off-Windows. */
const unavailableDpapi: Dpapi = {
	protect(): string {
		throw new SecretsError("DPAPI unavailable (simulated)");
	},
	unprotect(): string {
		throw new SecretsError("DPAPI unavailable (simulated)");
	},
};

let tmpDir: string;
let originalAgentDir: string | undefined;

beforeEach(() => {
	originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
	tmpDir = join(tmpdir(), `switchback-secrets-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
	mkdirSync(tmpDir, { recursive: true });
	process.env["PI_CODING_AGENT_DIR"] = tmpDir;
});

afterEach(() => {
	if (originalAgentDir === undefined) {
		delete process.env["PI_CODING_AGENT_DIR"];
	} else {
		process.env["PI_CODING_AGENT_DIR"] = originalAgentDir;
	}
	if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed the store file with exact bytes (creates the switchback dir). */
function seed(contents: string): string {
	const path = secretsFilePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, contents, "utf8");
	return path;
}

function quarantinedFiles(): string[] {
	const dir = piSwitchbackDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.startsWith("secrets.json.corrupt."));
}

/** Staging files `writeFileAtomic` uses, had it failed to rename one away. */
function stagingFiles(): string[] {
	const dir = piSwitchbackDir();
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter((f) => f.startsWith("secrets.json.") && f.endsWith(".tmp"));
}

describe("secret store — round-trip", () => {
	it("set then get returns the value", () => {
		const store = createSecretStore(mockDpapi);
		store.set("alpha", SECRET);
		expect(store.get("alpha")).toBe(SECRET);
	});

	it("get on an unknown name returns undefined", () => {
		expect(createSecretStore(mockDpapi).get("ghost")).toBeUndefined();
	});

	it("set overwrites an existing entry without duplicating it", () => {
		const store = createSecretStore(mockDpapi);
		store.set("alpha", SECRET);
		store.set("alpha", OTHER_SECRET);
		expect(store.get("alpha")).toBe(OTHER_SECRET);
		expect(store.list()).toEqual(["alpha"]);
	});

	it("persists across store instances: the file is the source of truth", () => {
		createSecretStore(mockDpapi).set("alpha", SECRET);
		expect(createSecretStore(mockDpapi).get("alpha")).toBe(SECRET);
	});

	it("a failed get surfaces the entry name but never the value", () => {
		const store = createSecretStore({
			protect: mockDpapi.protect,
			unprotect(): string {
				throw new SecretsError("DPAPI unprotect failed (simulated)");
			},
		});
		store.set("alpha", SECRET);
		let caught: unknown;
		try {
			store.get("alpha");
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SecretsError);
		const message = String(caught);
		expect(message).toContain('"alpha"');
		expect(message).not.toContain(SECRET);
	});
});

describe("secret store — delete / list", () => {
	it("delete removes the entry and persists", () => {
		const store = createSecretStore(mockDpapi);
		store.set("alpha", SECRET);
		store.set("beta", OTHER_SECRET);
		store.delete("alpha");
		expect(store.get("alpha")).toBeUndefined();
		expect(store.list()).toEqual(["beta"]);
		expect(createSecretStore(mockDpapi).get("alpha")).toBeUndefined();
	});

	it("delete of a missing name is a no-op and does not create the file", () => {
		createSecretStore(mockDpapi).delete("ghost");
		expect(existsSync(secretsFilePath())).toBe(false);
	});

	it("list returns names only and never a value", () => {
		const store = createSecretStore(mockDpapi);
		store.set("alpha", SECRET);
		store.set("beta", OTHER_SECRET);
		expect(store.list()).toEqual(["alpha", "beta"]);
		const listed = JSON.stringify(store.list());
		expect(listed).not.toContain(SECRET);
		expect(listed).not.toContain(OTHER_SECRET);
	});

	it("list on a missing file is an empty array", () => {
		expect(createSecretStore(mockDpapi).list()).toEqual([]);
	});
});

describe("secret store — on-disk format", () => {
	it("creates secrets.json under <piConfigDir>/switchback/ with version 1", () => {
		const store = createSecretStore(mockDpapi);
		store.set("alpha", SECRET);
		const parsed = JSON.parse(readFileSync(secretsFilePath(), "utf8")) as {
			version: number;
			entries: Record<string, string>;
		};
		expect(parsed.version).toBe(1);
		expect(Object.keys(parsed.entries)).toEqual(["alpha"]);
	});

	it("never writes the plaintext to disk", () => {
		const store = createSecretStore(mockDpapi);
		store.set("alpha", SECRET);
		const bytes = readFileSync(secretsFilePath(), "utf8");
		expect(bytes).not.toContain(SECRET);
		expect(bytes).toContain("enc:");
	});

	it("atomic write: no staging file is left behind", () => {
		createSecretStore(mockDpapi).set("alpha", SECRET);
		expect(stagingFiles()).toEqual([]);
	});
});

describe("secret store — corrupt handling", () => {
	it("quarantines unparseable JSON, starts fresh, keeps working", () => {
		seed("{definitely not json");
		const store = createSecretStore(mockDpapi);
		expect(store.list()).toEqual([]);
		expect(existsSync(secretsFilePath())).toBe(false);
		expect(quarantinedFiles()).toHaveLength(1);
		store.set("alpha", SECRET);
		expect(store.get("alpha")).toBe(SECRET);
	});

	it("quarantines a file that is not a JSON object", () => {
		seed("[1, 2, 3]");
		expect(createSecretStore(mockDpapi).list()).toEqual([]);
		expect(quarantinedFiles()).toHaveLength(1);
	});

	it("quarantines a file with a missing version field", () => {
		seed(JSON.stringify({ entries: {} }));
		expect(createSecretStore(mockDpapi).list()).toEqual([]);
		expect(quarantinedFiles()).toHaveLength(1);
	});

	it("quarantines a file whose entries are not a string map", () => {
		seed(JSON.stringify({ version: 1, entries: { alpha: 123 } }));
		expect(createSecretStore(mockDpapi).list()).toEqual([]);
		expect(quarantinedFiles()).toHaveLength(1);
	});

	it("treats an empty file as a fresh store without quarantining it", () => {
		seed("  \n");
		expect(createSecretStore(mockDpapi).list()).toEqual([]);
		expect(quarantinedFiles()).toHaveLength(0);
		expect(existsSync(secretsFilePath())).toBe(true);
	});

	it("refuses a readable file with a different version and leaves it untouched", () => {
		const path = seed(JSON.stringify({ version: 2, entries: { alpha: "blob" } }));
		let caught: unknown;
		try {
			createSecretStore(mockDpapi).list();
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SecretsError);
		expect(String(caught)).toContain("version 2");
		expect(existsSync(path)).toBe(true);
		expect(quarantinedFiles()).toHaveLength(0);
	});
});

describe("secret store — validation", () => {
	it("rejects an empty name", () => {
		expect(() => createSecretStore(mockDpapi).set("", SECRET)).toThrow(SecretsError);
		expect(() => createSecretStore(mockDpapi).set("   ", SECRET)).toThrow(SecretsError);
	});

	it("rejects an empty value without touching disk", () => {
		const store = createSecretStore(mockDpapi);
		expect(() => store.set("alpha", "")).toThrow(SecretsError);
		expect(existsSync(secretsFilePath())).toBe(false);
	});
});

describe("secret store — DPAPI unavailable", () => {
	it("set throws and leaves the existing store byte-identical: no plaintext fallback", () => {
		createSecretStore(mockDpapi).set("alpha", SECRET);
		const before = readFileSync(secretsFilePath(), "utf8");
		const store = createSecretStore(unavailableDpapi);
		let caught: unknown;
		try {
			store.set("beta", OTHER_SECRET);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(SecretsError);
		expect(String(caught)).not.toContain(OTHER_SECRET);
		expect(readFileSync(secretsFilePath(), "utf8")).toBe(before);
		expect(before).not.toContain(OTHER_SECRET);
		expect(stagingFiles()).toEqual([]);
	});

	it("get throws instead of returning anything when DPAPI is unavailable", () => {
		createSecretStore(mockDpapi).set("alpha", SECRET);
		const store = createSecretStore(unavailableDpapi);
		expect(() => store.get("alpha")).toThrow(SecretsError);
	});

	it.runIf(process.platform === "win32")(
		"the real powershell backend throws a clear SecretsError when powershell.exe cannot be spawned",
		() => {
			const savedPath = process.env["PATH"];
			process.env["PATH"] = "";
			try {
				const store = createSecretStore(); // default backend, temp-dir path
				let caught: unknown;
				try {
					store.set("alpha", SECRET);
				} catch (error) {
					caught = error;
				}
				expect(caught).toBeInstanceOf(SecretsError);
				const message = String(caught);
				expect(message).toMatch(/DPAPI/);
				expect(message).not.toContain(SECRET);
				expect(existsSync(secretsFilePath())).toBe(false);
			} finally {
				if (savedPath === undefined) delete process.env["PATH"];
				else process.env["PATH"] = savedPath;
			}
		},
	);
});

describe("secret store — live powershell (opt-in)", () => {
	it.runIf(process.env["SWITCHBACK_SECRETS_LIVE"] === "1")(
		"real DPAPI round-trip through powershell.exe",
		() => {
			const store = createSecretStore(); // default backend: the real powershell child
			const sentinel = `switchback-live-sentinel-${Date.now()}`; // synthetic, not a credential
			store.set("live", sentinel);
			expect(store.get("live")).toBe(sentinel);
			expect(store.list()).toEqual(["live"]);
			const bytes = readFileSync(secretsFilePath(), "utf8");
			expect(bytes).not.toContain(sentinel);
			expect(bytes).not.toContain(Buffer.from(sentinel, "utf8").toString("base64"));
			store.delete("live");
			expect(store.get("live")).toBeUndefined();
			expect(store.list()).toEqual([]);
		},
		60_000,
	);
});
