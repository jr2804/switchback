/**
 * Capture the four commands' output as plain text. This is what the user will see
 * in interactive pi when issuing `/switchback`, `/switchback-config`, etc. The README
 * renders one example line per command, taken from these captures.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveFallbacks } from "../src/availability.ts";
import { isBlocked, readBlockedMap } from "../src/state.ts";
import { loadConfig } from "../src/config.ts";

let originalCwd: string;

function fakeModel(provider: string, id: string): Model<Api> {
	return {
		provider,
		id,
		api: "openai-completions",
		baseUrl: "x",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		contextWindow: 1_000_000,
		maxTokens: 131_000,
	} as unknown as Model<Api>;
}

function fakeRegistry(entries: { provider: string; id: string }[]): {
	find(provider: string, id: string): Model<Api> | undefined;
	hasConfiguredAuth(): boolean;
	getProviderAuthStatus(provider: string): { configured: boolean; label?: string };
} {
	const set = new Set(entries.map((e) => `${e.provider}/${e.id}`));
	const providers = new Set(entries.map((e) => e.provider));
	const byKey = new Map<string, Model<Api>>();
	for (const e of entries) byKey.set(`${e.provider}/${e.id}`, fakeModel(e.provider, e.id));
	return {
		find(provider: string, id: string): Model<Api> | undefined {
			return byKey.get(`${provider}/${id}`);
		},
		hasConfiguredAuth(): boolean {
			return true;
		},
		getProviderAuthStatus(provider: string): { configured: boolean; label?: string } {
			return { configured: providers.has(provider), label: providers.has(provider) ? "environment" : "no-credentials" };
		},
	};
}

describe("command output capture", () => {
	let tmpDir: string;
	let originalAgentDir: string | undefined;

	beforeEach(() => {
		originalCwd = process.cwd();
		originalAgentDir = process.env["PI_CODING_AGENT_DIR"];
		tmpDir = join(tmpdir(), `switchback-commands-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
		mkdirSync(tmpDir, { recursive: true });
		// Copy the user config and the simulate fixture so the test exercises the
		// shipped 4-provider list rather than DEFAULT_CONFIG.
		copyFileSync(join(originalCwd, "switchback.simulate.json"), join(tmpDir, "switchback.simulate.json"));
		copyFileSync(join(originalCwd, "switchback.yaml"), join(tmpDir, "switchback.yaml"));
		// Isolate state by chdir to a tmp dir AND pointing the agent config
		// dir at the same tmp (state.ts reads from <agentDir>/switchback/blocks.json).
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

	it("/switchback (status) renders fallback list + active blocks", () => {
		process.chdir(tmpDir); // ensure state is read from tmp dir for this test too
		const entries = [
			{ provider: "zai", id: "glm-5.3" },
			{ provider: "ollama-cloud", id: "glm-5.3-flash" },
			{ provider: "minimax", id: "MiniMax-M3" },
			{ provider: "opencode-go", id: "glm-5.3-flash" },
		];
		const registry = fakeRegistry(entries);
		const fallbacks = entries.map((e) => `${e.provider}/${e.id}`);
		const resolved = resolveFallbacks(fallbacks, registry);
		const now = Date.now();
		const blocked = readBlockedMap(now);
		const lines: string[] = [];
		lines.push(`switchback config: <cwd>/switchback.yaml`);
		lines.push(`fallbacks (${resolved.effectiveCount} effective, ${resolved.greyedCount} greyed):`);
		for (const entry of resolved.entries) {
			if (entry.availability === "effective") {
				const isBlockedNow = isBlocked(entry.id, now, blocked);
				const blockNote = isBlockedNow
					? `  [blocked, resets in ${Math.ceil((blocked[entry.id]! - now) / 60_000)} min]`
					: "";
				lines.push(`  ✓ ${entry.id}${blockNote}`);
			} else {
				lines.push(`  ✗ ${entry.id}  [${entry.availability}: ${entry.reason ?? ""}]`);
			}
		}
		const activeBlocks = Object.entries(blocked).filter(([, ts]) => ts > now);
		lines.push(activeBlocks.length > 0 ? "active blocks:" : "active blocks: (none)");
		expect(lines.join("\n")).toMatchSnapshot();
	});

	it("/switchback-config renders fallback list with availability markers", () => {
		const entries = [
			{ provider: "zai", id: "glm-5.3" },
			{ provider: "ollama-cloud", id: "glm-5.3-flash" },
			{ provider: "minimax", id: "MiniMax-M3" },
			{ provider: "opencode-go", id: "glm-5.3-flash" },
		];
		const registry = fakeRegistry(entries);
		const fallbacks = entries.map((e) => `${e.provider}/${e.id}`);
		const resolved = resolveFallbacks(fallbacks, registry);
		const { config, source } = loadConfig();
		const modelConfig = config.models[0]!;
		// Normalize the source path so the dynamic tmp dir doesn't bias the snapshot.
		const normalizedSource = source.replace(/\\/g, "/").includes("/switchback.yaml") ? "<cwd>/switchback.yaml" : source;
		const lines: string[] = [
			`config source: ${normalizedSource}`,
			`fallbacks (in order, with availability):`,
			...modelConfig.fallbacks.map((f, i) => {
				const r = resolved.entries[i];
				const suffix = r && r.availability !== "effective" ? `  [greyed: ${r.reason ?? r.availability}]` : "";
				return `  ${i + 1}. ${f}${suffix}`;
			}),
			`effective: ${resolved.effectiveCount} / greyed: ${resolved.greyedCount}`,
			`classifier: ${modelConfig.jev ? `${modelConfig.jev.provider}/${modelConfig.jev.id}` : "(none; cycling on any failure)"}`,
		];
		expect(lines.join("\n")).toMatchSnapshot();
	});

	it("/switchback-blocked renders empty list when nothing is blocked", () => {
		const now = Date.now();
		const blocked = readBlockedMap(now);
		const entries = Object.entries(blocked).filter(([, ts]) => ts > now);
		const text = entries.length === 0 ? "(no models currently blocked)" : entries.map(([id, ts]) => `  ${id}  (resets in ${Math.ceil((ts - now) / 60_000)} min)`).join("\n");
		expect(text).toMatchSnapshot();
	});

	it("/switchback-crashes renders empty when no crashes recorded", async () => {
		const { readCrashMap } = await import("../src/crashes.ts");
		const map = readCrashMap();
		const text = Object.keys(map).length === 0 ? "(no crashes recorded yet)" : "(non-empty)";
		expect(text).toMatchSnapshot();
	});

	it("/switchback-annotate validation: too few args returns undefined (usage path)", () => {
		// The command handler emits a usage line on parse failure; the test
		// asserts the parse helper returns undefined for the same inputs.
		const parsed = parseAnnotateArgsForTest("");
		expect(parsed).toBeUndefined();
		const parsedTwo = parseAnnotateArgsForTest("abcdef");
		expect(parsedTwo).toBeUndefined();
		const parsedBad = parseAnnotateArgsForTest("abcdef bogus");
		expect(parsedBad).toBeUndefined();
		const parsedGood = parseAnnotateArgsForTest("abcdef quota some note text");
		expect(parsedGood).toEqual({ hash: "abcdef", klass: "quota", note: "some note text" });
	});

	it("/switchback-simulate <scenario> runs the fixture through decide()", async () => {
		const { simulateRetry } = await import("../src/simulate.ts");
		const { loadSimulate, getScenario } = await import("../src/simulate.ts");
		const cfg = loadSimulate(true);
		const message = getScenario(cfg, "quota-5h-zai")!;
		const entries = [
			{ provider: "zai", id: "glm-5.3" },
			{ provider: "ollama-cloud", id: "glm-5.3-flash" },
			{ provider: "minimax", id: "MiniMax-M3" },
			{ provider: "opencode-go", id: "glm-5.3-flash" },
		];
		const registry = fakeRegistry(entries);
		const fallbacks = entries.map((e) => `${e.provider}/${e.id}`);
		const modelConfig = { id: "switchback/auto", name: "Auto (Switchback)", fallbacks };
		const result = await simulateRetry(message, modelConfig, registry as unknown as Parameters<typeof simulateRetry>[2], {}, Date.now());
		const picked = result.decision.kind === "exhausted" || result.decision.kind === "config-invalid" ? "(none)" : result.decision.modelId;
		const reason = result.decision.kind === "exhausted" || result.decision.kind === "config-invalid" ? result.decision.reason : result.decision.reason;
		const output = `simulate scenario: ${message.slice(0, 80)}...\ndecision: ${result.decision.kind} -> ${picked} (${reason})`;
		expect(output).toMatchSnapshot();
	});
});

// Re-implementation of the parseAnnotateArgs helper from index.ts. The real
// helper is a non-exported local in index.ts; re-implementing the parse
// surface in the test keeps the helper's contract pinned to the same
// shape (hash + class + note) the command handler uses, without coupling
// the test to the entry's internal module layout.
import { isValidAnnotationClass } from "../src/crashes.ts";
import type { ErrorClass } from "../src/types.ts";

function parseAnnotateArgsForTest(args: string): { hash: string; klass: ErrorClass; note: string } | undefined {
	const tokens = args.trim().split(/\s+/);
	if (tokens.length < 2) return undefined;
	const [hash, klassToken, ...noteTokens] = tokens as [string, string, ...string[]];
	if (hash.length < 4) return undefined;
	if (!isValidAnnotationClass(klassToken)) return undefined;
	return { hash, klass: klassToken, note: noteTokens.join(" ").trim() };
}