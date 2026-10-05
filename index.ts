/**
 * switchback - quota-aware graceful model fallback for pi.
 *
 * Registers a virtual model `switchback/auto` that picks a physical model for each
 * request. Error classification goes through the configured SystemOne classifier
 * (Jev / von / whatever `ctx.modelRegistry.findOfType("classifier", ...)` returns).
 * When the classifier is missing, unresolvable, or its call fails, the router
 * reports the condition visibly (`ctx.ui.notify` when `ctx.hasUI`) and cycles to
 * the next model in the config list without writing to `.pi/switchback.json`.
 * Cross-session blocked-until state is only ever written from a classifier-given
 * class + reset, never from the cycle path.
 *
 * Usage: pi -e ./index.ts --model switchback/auto
 *
 * The full design lives in the design doc (see the project's task notes for the
 * canonical reference).
 */

import type { ExtensionAPI, ExtensionContext, ModelRoute } from "@earendil-works/pi-coding-agent";
import { resolveFallbacks, type AvailabilityRegistry } from "./src/availability.ts";
import { SWITCHBACK_PROVIDER, SWITCHBACK_VIRTUAL_ID, findModelConfig, loadConfig } from "./src/config.ts";
import { buildRoute, decide, ConfigInvalidError, type RouterRegistry } from "./src/routing.ts";
import { loadSimulate, getScenario, simulateRetry, type SimulateResult } from "./src/simulate.ts";
import { registerLocalClassifier } from "./src/local-classifier.ts";
import { isBlocked, readBlockedMap } from "./src/state.ts";
import { annotateCrash, isValidAnnotationClass, readCrashMap, shortHash } from "./src/crashes.ts";
import type { ErrorClass } from "./src/types.ts";
import type { ModelId, SwitchbackState } from "./src/types.ts";

export default function (pi: ExtensionAPI) {
	const { config, source: configSource } = loadConfig();
	const modelConfig = findModelConfig(config, `${SWITCHBACK_PROVIDER}/${SWITCHBACK_VIRTUAL_ID}`);

	// A classifier that names its own endpoint (jev.baseUrl) is registered here, so
	// switchback can classify through a local System One server (e.g. Ollama
	// v0.35+) without a pi provider for it. No-op for catalog classifiers.
	registerLocalClassifier(pi, modelConfig.jev);

	pi.registerVirtualModel<SwitchbackState>({
		provider: SWITCHBACK_PROVIDER,
		id: SWITCHBACK_VIRTUAL_ID,
		name: modelConfig.name,
		thinkingLevels: ["off", "low", "medium", "high"],
		async route(request, ctx) {
			const now = Date.now();
			const blocked = readBlockedMap(now);
			// Wire the no-classifier report to ctx.ui.notify when pi is running
			// in a UI-capable mode (TUI / RPC). In non-UI modes (print, RPC-no-ui)
			// the call is a no-op so simulate/replay and headless runs are silent.
			const notify: import("./src/routing.ts").NotifyFn = ctx.hasUI
				? (message, type) => ctx.ui.notify(message, type)
				: () => {};
			const result = await decide(request.reason, request, modelConfig, ctx.modelRegistry, {
				now,
				blocked,
				notify,
			});
			return buildRoute(ctx.modelRegistry, result.decision, result.thinkingLevel, result.nextState);
		},
	});

	// `/switchback-config` surfaces the active config source for the user.
	pi.registerCommand("switchback-config", {
		description: "Show the active switchback config source and fallback list",
		handler: async (_args, ctx) => {
			const resolved = resolveFallbacks(modelConfig.fallbacks, ctx.modelRegistry as AvailabilityRegistry);
			const lines: string[] = [
				`config source: ${configSource}`,
				`fallbacks (in order, with availability):`,
				...modelConfig.fallbacks.map((f: ModelId, i: number) => {
					const r = resolved.entries[i];
					const suffix = r && r.availability !== "effective" ? `  [greyed: ${r.reason ?? r.availability}]` : "";
					return `  ${i + 1}. ${f}${suffix}`;
				}),
				`effective: ${resolved.effectiveCount} / greyed: ${resolved.greyedCount}`,
				`classifier: ${modelConfig.jev ? `${modelConfig.jev.provider}/${modelConfig.jev.id}` : "(none; cycling on any failure)"}`,
			];
			await ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// `/switchback-blocked` lists currently blocked models and their reset times.
	pi.registerCommand("switchback-blocked", {
		description: "List models currently blocked by the switchback router",
		handler: async (_args, ctx) => {
			const now = Date.now();
			const blocked = readBlockedMap(now);
			const entries = Object.entries(blocked)
				.filter(([, ts]) => ts > now)
				.sort(([, a], [, b]) => a - b);
			if (entries.length === 0) {
				await ctx.ui.notify("(no models currently blocked)", "info");
				return;
			}
			const lines = entries.map(([modelId, ts]) => {
				const mins = Math.ceil((ts - now) / 60_000);
				return `  ${modelId}  (resets in ${mins} min)`;
			});
			await ctx.ui.notify(`blocked models:\n${lines.join("\n")}`, "info");
		},
	});

	// `/switchback` — comprehensive status (current model, effective vs greyed,
	// active blocks with expiry, dwell state).
	pi.registerCommand("switchback", {
		description: "Show switchback status: current model, fallbacks (effective/greyed), active blocks",
		handler: async (_args, ctx) => {
			const resolved = resolveFallbacks(modelConfig.fallbacks, ctx.modelRegistry as AvailabilityRegistry);
			const now = Date.now();
			const blocked = readBlockedMap(now);
			const lines: string[] = [];
			lines.push(`switchback config: ${configSource}`);
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
			if (activeBlocks.length > 0) {
				lines.push(`active blocks:`);
				for (const [id, ts] of activeBlocks) {
					lines.push(`  ${id}  (resets in ${Math.ceil((ts - now) / 60_000)} min)`);
				}
			} else {
				lines.push(`active blocks: (none)`);
			}
			await ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// `/switchback-simulate` is a test-only command: it triggers a one-shot retry on
	// the first fallback with a synthetic error message from the configured simulate
	// fixture. Useful for manual smoke tests when no real provider is quota-exhausted.
	pi.registerCommand("switchback-simulate", {
		description: "Simulate a failed request with a synthetic error from the fixture file",
		handler: async (args, ctx) => {
			const scenario = args.trim();
			if (scenario.length === 0) {
				await ctx.ui.notify("usage: /switchback-simulate <scenario-name>", "warning");
				return;
			}
			const simulateConfig = loadSimulate(true);
			const message = getScenario(simulateConfig, scenario);
			if (message === undefined) {
				const known = Object.keys(simulateConfig.scenarios).join(", ");
				await ctx.ui.notify(`unknown scenario "${scenario}"; known: ${known}`, "warning");
				return;
			}
			const result = await runSimulate(modelConfig, message, ctx.modelRegistry);
			const picked: ModelId = result.decision.kind === "exhausted" || result.decision.kind === "config-invalid"
				? "(none)"
				: result.decision.modelId;
			const reason = result.decision.kind === "exhausted" || result.decision.kind === "config-invalid"
				? result.decision.reason
				: result.decision.reason;
			await ctx.ui.notify(
				`simulate scenario: ${message.slice(0, 80)}...\ndecision: ${result.decision.kind} -> ${picked} (${reason})`,
				"info",
			);
		},
	});

	// `/switchback-crashes [n]` lists the most-recent N entries in crashes.json
	// (default 10). Each row shows the short-hash, provider/model, class-or-reason,
	// count, last-seen, and an [annot] marker when the entry is annotated.
	pi.registerCommand("switchback-crashes", {
		description: "List the most-recent N crash entries (default 10)",
		handler: async (args, ctx) => {
			const n = parseCount(args, 10);
			if (n === undefined) {
				await ctx.ui.notify("usage: /switchback-crashes [n]", "warning");
				return;
			}
			const map = readCrashMap();
			const entries = Object.entries(map)
				.sort(([, a], [, b]) => b.last - a.last)
				.slice(0, n);
			if (entries.length === 0) {
				await ctx.ui.notify("(no crashes recorded yet)", "info");
				return;
			}
			const lines: string[] = [`crashes (${entries.length} of ${Object.keys(map).length} total):`];
			for (const [hash, e] of entries) {
				const clsOrReason = e.verdict ? `${e.verdict.class}` : `no-classifier (${e.noClassifierReason ?? "?"})`;
				const annotated = e.annotated ? "  [annot]" : "";
				const lastMin = Math.max(0, Math.floor((Date.now() - e.last) / 60_000));
				lines.push(`  ${shortHash(hash)}  ${e.provider}/${e.model}  ${clsOrReason}  count=${e.count}  last=${lastMin}m ago  action=${e.action}${annotated}`);
			}
			await ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// `/switchback-annotate <hash> <class> [note...]` writes a user-confirmed class
	// onto a stored crash. After annotation, the Tier 2b cache in classifyError
	// short-circuits the classifier call for the exact same raw bytes.
	pi.registerCommand("switchback-annotate", {
		description: "Annotate a crash with a confirmed class (Tier 2b cache)",
		handler: async (args, ctx) => {
			const parsed = parseAnnotateArgs(args);
			if (parsed === undefined) {
				await ctx.ui.notify("usage: /switchback-annotate <hash> <quota|auth|transient|overflow|unknown> [note...]", "warning");
				return;
			}
			const { hash, klass, note } = parsed;
			try {
				annotateCrash(hash, klass, note);
				await ctx.ui.notify(`annotated ${hash} as ${klass}${note ? ` (${note})` : ""}`, "info");
			} catch (e) {
				const message = e instanceof Error ? e.message : String(e);
				await ctx.ui.notify(message, "warning");
			}
		},
	});
}

async function runSimulate(
	modelConfig: { id: string; name: string; fallbacks: ModelId[] },
	message: string,
	registry: ExtensionContext["modelRegistry"],
): Promise<SimulateResult> {
	const now = Date.now();
	const blocked = readBlockedMap(now);
	return simulateRetry(message, modelConfig, registry, { now, blocked });
}

/**
 * Parse the [n] argument for `/switchback-crashes`. Returns undefined when the
 * argument is non-numeric; returns a positive integer otherwise. An empty
 * argument returns the default.
 */
function parseCount(args: string, defaultValue: number): number | undefined {
	const trimmed = args.trim();
	if (trimmed.length === 0) return defaultValue;
	const n = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	return n;
}

/**
 * Parse the args for `/switchback-annotate <hash> <class> [note...]`. Returns
 * undefined on parse failure (so the handler can emit the usage line).
 */
function parseAnnotateArgs(args: string): { hash: string; klass: ErrorClass; note: string } | undefined {
	const tokens = args.trim().split(/\s+/);
	if (tokens.length < 2) return undefined;
	const [hash, klassToken, ...noteTokens] = tokens as [string, string, ...string[]];
	if (hash.length < 4) return undefined;
	if (!isValidAnnotationClass(klassToken)) return undefined;
	return { hash, klass: klassToken, note: noteTokens.join(" ").trim() };
}

// Re-export the routing types and helpers for tests and other extensions.
export {
	decide,
	buildRoute,
	ConfigInvalidError,
	loadConfig,
	findModelConfig,
	loadSimulate,
	getScenario,
	readBlockedMap,
	simulateRetry,
	resolveFallbacks,
} from "./src/index.ts";
export type { SimulateResult, SwitchbackState } from "./src/index.ts";
export type { ModelRoute } from "@earendil-works/pi-coding-agent";
export type { AvailabilityRegistry } from "./src/availability.ts";
export type { RouterRegistry } from "./src/routing.ts";
