/**
 * switchback - quota-aware graceful model fallback for pi.
 *
 * Registers one virtual model per entry in the user config (so `switchback/auto`
 * and `switchback/auto-flash` both appear in `/model`). Each request is routed
 * through the configured SystemOne classifier (Jev / von / whatever
 * `ctx.modelRegistry.findOfType("classifier", ...)` returns). When the classifier is
 * missing, unresolvable, or its call fails, the router reports the condition
 * visibly (`ctx.ui.notify` when `ctx.hasUI`) and cycles to the next model in the
 * config list without writing to `.pi/switchback.json`. Cross-session blocked-until
 * state is only ever written from a classifier-given class + reset, never from the
 * cycle path.
 *
 * Usage: pi -e ./index.ts --model switchback/auto
 *
 * Configuration: the user config is aggregated from two YAML layers
 * (`<cwd>/.pi/switchback.yaml` on top of `~/.pi/agent/switchback.yaml`), each entry
 * a virtual model. Bare ids (`auto`) are normalized to the provider prefix
 * (`switchback/auto`). Edits to the file are picked up on the next request: the
 * router reloads the config per route, surfaces a warning when a reload fails, and
 * falls back to the last good config so a broken edit never kills the session.
 *
 * The full design lives in the design doc (see the project's task notes for the
 * canonical reference).
 */

import type { ExtensionAPI, ExtensionContext, ModelRoute } from "@earendil-works/pi-coding-agent";
import { resolveFallbacks, type AvailabilityRegistry } from "./src/availability.ts";
import { SWITCHBACK_PROVIDER, findModelConfig, loadConfig } from "./src/config.ts";
import { runDialogue } from "./src/dialogue.ts";
import { createSecretStore } from "./src/secrets.ts";
import { buildRoute, decide, ConfigInvalidError, type RouterRegistry } from "./src/routing.ts";
import { registerLocalClassifier } from "./src/local-classifier.ts";
import { SWITCHBACK_THINKING_LEVELS } from "./src/thinking.ts";
import { getPinnedModel, isBlocked, readBlockedMap, readPinMap, setPinnedModel } from "./src/state.ts";
import { annotateCrash, isValidAnnotationClass, readCrashMap, shortHash } from "./src/crashes.ts";
import type { ErrorClass, ModelId, ResolvedSwitchbackConfig, ResolvedSwitchbackFileConfig, SwitchbackState } from "./src/types.ts";

export default function (pi: ExtensionAPI) {
	// Secrets: `apiKey: secret:<name>` references in the config are resolved to
	// plaintext here (never written back to the YAML). One store instance for the
	// whole extension lifetime - a DPAPI round-trip is not free.
	const secrets = createSecretStore();
	const initial = safeLoad(pi, secrets);
	const modelConfigs = initial.config.models;
	const configSource = initial.source;
	// Diagnostic switch notifications: the config's `debug: true`, overridden by the
	// SWITCHBACK_DEBUG environment variable for quick toggling without a config edit.
	const debug = debugFlag(process.env["SWITCHBACK_DEBUG"]) ?? initial.config.debug ?? false;

	// A classifier that names its own endpoint (jev.baseUrl) is registered here, so
	// switchback can classify through a local System One server (e.g. Ollama
	// v0.35+) without a pi provider for it. No-op for catalog classifiers. Registered
	// once per distinct endpoint, since several virtual models may share one.
	const registeredEndpoints = new Set<string>();
	for (const modelConfig of modelConfigs) {
		const jev = modelConfig.jev;
		if (jev?.baseUrl === undefined) continue;
		const key = `${jev.provider}|${jev.baseUrl}`;
		if (registeredEndpoints.has(key)) continue;
		registeredEndpoints.add(key);
		registerLocalClassifier(pi, jev);
	}

	// Last successfully loaded config; reloaded on every route so edits to
	// switchback.yaml are picked up live. A broken edit fails loudly on the first
	// affected route but does not kill the session.
	let lastGoodConfig: ResolvedSwitchbackFileConfig = initial.config;

	for (const modelConfig of modelConfigs) {
		const fullVirtualId = modelConfig.id;
		pi.registerVirtualModel<SwitchbackState>({
			provider: virtualProvider(fullVirtualId),
			id: virtualId(fullVirtualId),
			name: modelConfig.name,
			// One fixed category scale for every switchback model. The concrete model's
			// own level map is resolved at activation time by the classifier, so the
			// offered set does not have to be the intersection of the fallbacks' maps.
			thinkingLevels: SWITCHBACK_THINKING_LEVELS,
			async route(request, ctx) {
				const now = Date.now();
				const blocked = readBlockedMap(now);
				const pinned = getPinnedModel(fullVirtualId);
				// Wire the no-classifier report to ctx.ui.notify when pi is running
				// in a UI-capable mode (TUI / RPC). In non-UI modes (print, RPC-no-ui)
				// the call is a no-op so simulate/replay and headless runs are silent.
				const notify: import("./src/routing.ts").NotifyFn = ctx.hasUI
					? (message, type) => ctx.ui.notify(message, type)
					: () => {};
				// Live-reload the config so edits to switchback.yaml are picked up without
				// a restart. On parse/validation failure, keep the last good config and
				// warn once; the broken edit does not break the session.
				let activeConfig: ResolvedSwitchbackFileConfig;
				try {
					const reloaded = loadConfig(secrets);
					lastGoodConfig = reloaded.config;
					activeConfig = reloaded.config;
				} catch (error) {
					notify(
						`switchback config reload failed (using last good): ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					activeConfig = lastGoodConfig;
				}
				const modelConfig: ResolvedSwitchbackConfig = findModelConfig(activeConfig, fullVirtualId);
				// The context size pi reports for the *routed* model. Only used to prefer a
				// switch target that can hold the conversation (see src/context-fit.ts).
				// pi reports null when no assistant has answered since the last compaction.
				const contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
				const result = await decide(request.reason, request, modelConfig, ctx.modelRegistry, {
					now,
					blocked,
					notify,
					debug,
					...(pinned !== null && pinned !== undefined ? { pinned } : {}),
					...(contextTokens !== undefined ? { contextTokens } : {}),
				});
				return buildRoute(ctx.modelRegistry, result.decision, result.thinkingLevel, result.nextState);
			},
		});
	}

	// `/switchback` — single overview: config source, debug, per-model pin +
	// fallbacks (effective / greyed + blocks + reset), active blocks.
	pi.registerCommand("switchback", {
		description: "Show switchback config: source, debug, per-model pin, fallbacks (effective/greyed/blocks)",
		handler: async (_args, ctx) => {
			const now = Date.now();
			const reloaded = safeLoadForCommand(pi, secrets);
			const config = reloaded.config;
			const blocked = readBlockedMap(now);
			const pinMap = readPinMap();
			const lines: string[] = [];
			lines.push(`switchback config: ${reloaded.source}${debug ? "  [debug on]" : ""}`);
			if (config.debug === true) lines.push("debug: true");
			if (Object.keys(pinMap).length > 0) {
				const pinLines = Object.entries(pinMap)
					.filter(([, p]) => p !== null)
					.map(([v, p]) => `  ${v} -> ${p}`);
				if (pinLines.length > 0) lines.push(`pin:\n${pinLines.join("\n")}`);
			}
			for (const modelConfig of config.models) {
				const resolved = resolveFallbacks(modelConfig.fallbacks, ctx.modelRegistry as AvailabilityRegistry);
				lines.push(`${modelConfig.id} (${resolved.effectiveCount} effective, ${resolved.greyedCount} greyed):`);
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
			}
			const activeBlocks = Object.entries(blocked).filter(([, ts]) => ts > now);
			if (activeBlocks.length > 0) {
				lines.push("active blocks:");
				for (const [id, ts] of activeBlocks) {
					lines.push(`  ${id}  (resets in ${Math.ceil((ts - now) / 60_000)} min)`);
				}
			} else {
				lines.push("active blocks: (none)");
			}
			await ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// `/switchback-config` — interactive editor for the switchback.yaml layers:
	// virtual models, fallback order, decision models, encrypted API-key secrets
	// and the debug flag. Each action is validated through the loader's single
	// gate (validateFileConfig + resolveJevConfig) and saved immediately, so the
	// file on disk always holds the last good config; a failed action reverts.
	pi.registerCommand("switchback-config", {
		description: "Interactively configure virtual models, fallbacks, decision models, API keys and debug",
		handler: async (_args, ctx) => {
			await runDialogue(ctx, secrets);
		},
	});

	// `/switchback-next` — cycle the session's virtual-model pin through its fallback
	// list (including "off" between the last fallback and the first). The pin is the
	// user's explicit "route here" override: it wins over both stickiness and the
	// preference list for as long as the pinned model is usable. A blocked or greyed
	// pin is ignored, and the status command shows why.
	pi.registerCommand("switchback-next", {
		description: "Cycle the pin to the next fallback of the current switchback model (pin off to start)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				await ctx.ui.notify("/switchback-next needs a UI-capable context (TUI or RPC)", "warning");
				return;
			}
			const current = ctx.model;
			if (current === undefined) {
				await ctx.ui.notify("no active model in this session", "warning");
				return;
			}
			if (current.provider !== SWITCHBACK_PROVIDER) {
				await ctx.ui.notify(
					`switchback-next only cycles switchback models; current is "${current.provider}/${current.id}"`,
					"warning",
				);
				return;
			}
			const virtualId = `${current.provider}/${current.id}`;
			const reloaded = safeLoadForCommand(pi, secrets);
			const modelConfig = findModelConfig(reloaded.config, virtualId);
			const choices: ReadonlyArray<ModelId | null> = [null, ...modelConfig.fallbacks];
			const currentPin = getPinnedModel(virtualId);
			const currentIdx = currentPin === undefined ? -1 : choices.indexOf(currentPin);
			const nextIdx = currentIdx < 0 ? 0 : (currentIdx + 1) % choices.length;
			const next = choices[nextIdx] ?? null;
			setPinnedModel(virtualId, next);
			await ctx.ui.notify(
				next === null
					? `${virtualId}: pin cleared (router falls through to stickiness + preference)`
					: `${virtualId}: pinned to ${next}${nextIdx === 0 ? " (cycled)" : ""}`,
				"info",
			);
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
				await ctx.ui.notify("usage: /switchback-annotate <hash-prefix> <class> [note...]", "warning");
				return;
			}
			const map = readCrashMap();
			const matches = Object.entries(map).filter(([hash]) => hash.startsWith(parsed.hash));
			if (matches.length === 0) {
				await ctx.ui.notify(`no crash matches hash prefix "${parsed.hash}"`, "warning");
				return;
			}
			if (matches.length > 1 && !parsed.hash.match(/^[0-9a-f]{8}$/)) {
				const list = matches.map(([h]) => `  ${shortHash(h)}  ${map[h]?.provider}/${map[h]?.model}`).join("\n");
				await ctx.ui.notify(`ambiguous hash prefix; matches:\n${list}\nuse a longer prefix`, "warning");
				return;
			}
			if (!isValidAnnotationClass(parsed.class)) {
				await ctx.ui.notify(`class must be one of: ${["quota","auth","transient","overflow","unknown"].join(", ")}`, "warning");
				return;
			}
			const first = matches[0];
			if (first === undefined) return;
			const hash = first[0];
			const crash = first[1];
			const updated = annotateCrash(hash, parsed.class as ErrorClass, parsed.note ?? "");
			if (!updated) {
				await ctx.ui.notify(`annotation failed for ${shortHash(hash)}`, "error");
				return;
			}
			await ctx.ui.notify(
				`annotated ${shortHash(hash)} (${crash.provider}/${crash.model}) as ${parsed.class}${parsed.note !== undefined ? ` — note: ${parsed.note}` : ""}`,
				"info",
			);
		},
	});
}

/**
 * Provider part of a configured virtual model id (`switchback/auto` -> `switchback`).
 */
function virtualProvider(fullId: string): string {
	const slash = fullId.indexOf("/");
	return slash > 0 ? fullId.slice(0, slash) : SWITCHBACK_PROVIDER;
}

/**
 * Id part of a configured virtual model id (`switchback/auto` -> `auto`).
 */
function virtualId(fullId: string): string {
	const slash = fullId.indexOf("/");
	return slash >= 0 ? fullId.slice(slash + 1) : fullId;
}

/** Parse an on/off environment variable; undefined when it does not carry a flag. */
function debugFlag(value: string | undefined): boolean | undefined {
	const v = value?.trim().toLowerCase();
	if (v === undefined || v === "") return undefined;
	return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * Load the config; surfaces a no-config warning when no file is found rather than
 * throwing (commands run at any time, not just during routing).
 */
function safeLoad(pi: ExtensionAPI, secrets?: { get(name: string): string | undefined }): {
	config: ResolvedSwitchbackFileConfig;
	source: string;
} {
	try {
		return loadConfig(secrets);
	} catch (error) {
		const message = error instanceof ConfigInvalidError
			? error.message
			: error instanceof Error
				? error.message
				: String(error);
		// Best-effort notify: commands only exist after this factory completes, so
		// this path is only hit on a truly broken config. Fall back to stderr so the
		// extension is at least visible in the host log.
		console.warn(`switchback: failed to load config (using defaults): ${message}`);
		return {
			config: {
				models: [{ id: `${SWITCHBACK_PROVIDER}/auto`, name: "Auto (Switchback) - defaults", fallbacks: [] }],
			},
			source: "<default - load failed>",
		};
	}
}

function safeLoadForCommand(pi: ExtensionAPI, secrets?: { get(name: string): string | undefined }): {
	config: ResolvedSwitchbackFileConfig;
	source: string;
} {
	return safeLoad(pi, secrets);
}

export { ConfigInvalidError };

// The following parse helpers are tiny, so they live here rather than in a
// dedicated utility module; they are tested via tests/commands.test.ts.
function parseCount(args: string, fallback: number): number | undefined {
	const trimmed = args.trim();
	if (trimmed.length === 0) return fallback;
	const n = Number(trimmed);
	if (!Number.isInteger(n) || n < 1) return undefined;
	return n;
}

interface ParsedAnnotateArgs {
	hash: string;
	class: string;
	note?: string;
}

function parseAnnotateArgs(args: string): ParsedAnnotateArgs | undefined {
	const parts = args.trim().split(/\s+/u).filter((p) => p.length > 0);
	if (parts.length < 2) return undefined;
	const [maybeHash, maybeClass, ...rest] = parts;
	if (maybeHash === undefined || maybeClass === undefined) return undefined;
	const hashOk = /^[0-9a-f]{4,}$/u.test(maybeHash);
	if (!hashOk) return undefined;
	const note = rest.length > 0 ? rest.join(" ") : undefined;
	return note === undefined
		? { hash: maybeHash, class: maybeClass }
		: { hash: maybeHash, class: maybeClass, note };
}