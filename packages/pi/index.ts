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
 * Usage: pi -e ./packages/pi/index.ts --model switchback/auto
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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveFallbacks } from "switchback-core/availability.ts";
import type { AvailabilityPort, NotifyPort } from "switchback-core/ports.ts";
import { SWITCHBACK_PROVIDER, findModelConfig, loadConfig } from "switchback-core/config.ts";
import { runDialogue } from "./src/dialogue.ts";
import { createSecretStore } from "./src/secrets.ts";
import { buildRoute, ConfigInvalidError } from "./src/build-route.ts";
import { observeUnretriedFailure } from "switchback-core/failure.ts";
import { decide } from "switchback-core/routing.ts";
import { buildClassifierProviders } from "switchback-core/classifier-catalog.ts";
import {
	buildProbeContext,
	probeLocalClassifier,
	summarizeProbe,
	type ProbeResult,
} from "switchback-core/classifier-probe.ts";
import { createModelPicker } from "./src/model-picker.ts";
import { groupLocalEndpoints, registerLocalClassifier } from "./src/local-classifier.ts";
import { piThinkingSupport } from "./src/thinking-support.ts";
import { SWITCHBACK_THINKING_LEVELS } from "switchback-core/thinking.ts";
import {
	clearDisabled,
	disableModel,
	disabledFilePath,
	enableModel,
	getPinnedModel,
	isBlocked,
	isDisabled,
	readBlockedMap,
	readDisabledMap,
	readPinMap,
	setPinnedModel,
} from "switchback-core/state.ts";
import { annotateCrash, hashSample, isValidAnnotationClass, readCrashMap, shortHash } from "switchback-core/crashes.ts";
import type {
	ErrorClass,
	DecisionModelConfig,
	ModelId,
	ResolvedSwitchbackConfig,
	ResolvedSwitchbackFileConfig,
	SwitchbackState,
} from "switchback-core/types.ts";

export default function (pi: ExtensionAPI) {
	// Secrets: `apiKey: secret:<name>` references in the config are resolved to
	// plaintext here (never written back to the YAML). One store instance for the
	// whole extension lifetime - a DPAPI round-trip is not free.
	const secrets = createSecretStore();
	const initial = safeLoad(pi, secrets);
	const modelConfigs = initial.config.models;
	// Diagnostic switch notifications: the config's `debug: true`, overridden by the
	// SWITCHBACK_DEBUG environment variable for quick toggling without a config edit.
	const debug = debugFlag(process.env["SWITCHBACK_DEBUG"]) ?? initial.config.debug ?? false;

	// A classifier that names its own endpoint (decisionModel.baseUrl) is registered here, so
	// switchback can classify through a local System One server (e.g. Ollama
	// v0.35+) without a pi provider for it. No-op for catalog classifiers. Every
	// direct endpoint is registered **once**, carrying all the classifier models
	// that share it - pi replaces a provider's model list wholesale when an
	// extension supplies one, and a model left out of that list is invisible to
	// `findOfType`. Decision models count even when no virtual model references
	// them, so an endpoint stays registered while a model list is being edited.
	for (const endpoint of groupLocalEndpoints([
		...modelConfigs.flatMap((modelConfig) =>
			modelConfig.decisionModel === undefined ? [] : [modelConfig.decisionModel],
		),
		...Object.values(initial.config.decisionModels ?? {}),
	])) {
		registerLocalClassifier(pi, endpoint);
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
				const notify: NotifyPort = ctx.hasUI ? (message, type) => ctx.ui.notify(message, type) : () => {};
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
				// switch target that can hold the conversation (see packages/core/src/context-fit.ts).
				// pi reports null when no assistant has answered since the last compaction.
				const contextTokens = ctx.getContextUsage()?.tokens ?? undefined;
				const result = await decide(request.reason, request, modelConfig, ctx.modelRegistry, {
					now,
					blocked,
					disabled: readDisabledMap(),
					support: piThinkingSupport(ctx.modelRegistry),
					notify,
					debug,
					...(pinned !== null && pinned !== undefined ? { pinned } : {}),
					...(contextTokens !== undefined ? { contextTokens } : {}),
				});
				return buildRoute(ctx.modelRegistry, result.decision, result.thinkingLevel, result.nextState);
			},
		});

		// Failures pi will not retry.
		//
		// pi only shows a router an error when `isRetryableAssistantError` accepts
		// its text - a string match against two fixed lists. A provider-limit error
		// that trips the non-retryable list (a quota message whose text happens to
		// mention `billing`, for instance) or neither list never reaches `route()`,
		// so `request.failed` is absent, nothing is classified, the model is never
		// blocked, and the next turn walks back into it. The retry path above is
		// untouched: that one *is* pi's retry, re-routed rather than second-guessed.
		//
		// This hook is the fallback for the cases pi gave up on. It produces the
		// verdict and the block with the same code (`observeUnretriedFailure` ->
		// `assessFailure`), never touches pi's retry machinery, and cannot re-route a
		// run that has already ended - it only ensures the next routing decision
		// leaves the dead model behind, which the `user` path already does for a
		// blocked current model.
		const handledFailures = new Set<string>();
		const rememberHandled = (raw: string): void => {
			handledFailures.add(hashSample(raw));
			if (handledFailures.size > 64) {
				// Small, bounded, session-scoped: only needs to cover the retries of
				// one run, not the whole transcript.
				const oldest = handledFailures.values().next();
				if (!oldest.done) handledFailures.delete(oldest.value);
			}
		};
		pi.on("agent_end", (event, ctx) => {
			void (async () => {
				for (const message of event.messages) {
					if (message.role !== "assistant" || message.stopReason !== "error") continue;
					const errorMessage = message.errorMessage;
					if (errorMessage === undefined || errorMessage.trim().length === 0) continue;
					if (handledFailures.has(hashSample(errorMessage))) continue;
					let config: ResolvedSwitchbackFileConfig;
					try {
						config = loadConfig(secrets).config;
					} catch {
						// A broken config must not turn a provider error into an
						// extension throw; the router will report it on the next route.
						continue;
					}
					const modelConfig = findModelConfig(config, fullVirtualId);
					const now = Date.now();
					const acted = await observeUnretriedFailure({
						failedId: `${message.provider}/${message.model}`,
						errorMessage,
						stopReason: message.stopReason,
						decisionModel: modelConfig.decisionModel,
						registry: ctx.modelRegistry,
						now,
						blocked: readBlockedMap(now),
						...(debug && ctx.hasUI
							? { notify: (m: string, t: "info" | "warning" | "error") => ctx.ui.notify(m, t) }
							: {}),
					});
					if (acted || handledFailures.size === 0) rememberHandled(errorMessage);
				}
			})();
		});
	}

	// `/switchback` — single overview: config source, debug, per-model pin +
	// fallbacks (effective / greyed + blocks + manual disables + reset), active
	// blocks, and the models the user disabled by hand.
	pi.registerCommand("switchback", {
		description: "Show switchback config: source, debug, pin, fallbacks (effective/greyed/blocks/disabled)",
		handler: async (_args, ctx) => {
			const now = Date.now();
			const reloaded = safeLoadForCommand(pi, secrets);
			const config = reloaded.config;
			const blocked = readBlockedMap(now);
			const disabled = readDisabledMap();
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
				const resolved = resolveFallbacks(modelConfig.fallbacks, ctx.modelRegistry as AvailabilityPort);
				lines.push(`${modelConfig.id} (${resolved.effectiveCount} effective, ${resolved.greyedCount} greyed):`);
				for (const entry of resolved.entries) {
					if (entry.availability === "effective") {
						const isBlockedNow = isBlocked(entry.id, now, blocked);
						const isDisabledNow = isDisabled(entry.id, disabled);
						const notes: string[] = [];
						if (isDisabledNow) notes.push("disabled by hand");
						if (isBlockedNow)
							notes.push(`blocked, resets in ${Math.ceil((blocked[entry.id]! - now) / 60_000)} min`);
						lines.push(
							`  ${isDisabledNow ? "⊘" : "✓"} ${entry.id}${notes.length === 0 ? "" : `  [${notes.join("; ")}]`}`,
						);
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
			const disabledIds = Object.keys(disabled).sort();
			if (disabledIds.length > 0) {
				lines.push(`disabled by hand (${disabledIds.length}) - ${disabledFilePath()}:`);
				for (const id of disabledIds) lines.push(`  ${id}`);
				lines.push("  (/switchback-enable <provider/model|all> restores)");
			} else {
				lines.push("disabled by hand: (none)");
			}
			await ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// `/switchback-disable` - keep a configured fallback out of every chain until
	// it is enabled again. The list lives in the state dir (`disabled.json`), not
	// in switchback.yaml, so regenerating the config cannot silently re-enable a
	// model the user turned off.
	pi.registerCommand("switchback-disable", {
		description: "Keep a model out of every chain until re-enabled: /switchback-disable <provider/model>",
		getArgumentCompletions: (argumentPrefix) => {
			const known = configuredFallbacks(safeLoadForCommand(pi, secrets).config);
			return known
				.filter((id) => id.toLowerCase().startsWith(argumentPrefix.toLowerCase()))
				.map((id) => ({ value: id, label: id, description: "configured fallback" }));
		},
		handler: async (args, ctx) => {
			const target = args.trim();
			const addresses = configuredFallbacks(safeLoadForCommand(pi, secrets).config);
			if (target.length === 0) {
				await ctx.ui.notify(
					`switchback-disable: name a model address\nconfigured fallbacks:\n${
						addresses.length === 0 ? "  (none)" : addresses.map((id) => `  ${id}`).join("\n")
					}`,
					"info",
				);
				return;
			}
			const address = matchAddress(addresses, target);
			if (address === undefined) {
				await ctx.ui.notify(
					`switchback: ${JSON.stringify(target)} is not a configured fallback; known addresses: ${
						addresses.length === 0 ? "(none)" : addresses.join(", ")
					}`,
					"warning",
				);
				return;
			}
			const changed = disableModel(address);
			await ctx.ui.notify(
				changed
					? `switchback: disabled ${address} (${disabledFilePath()}) - /switchback-enable ${address} restores it`
					: `switchback: ${address} was already disabled`,
				"info",
			);
		},
	});

	// `/switchback-enable` - undo a manual disable, one model or all of them.
	pi.registerCommand("switchback-enable", {
		description: "Re-enable a manually disabled model: /switchback-enable <provider/model|all>",
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.toLowerCase();
			const disabledIds = Object.keys(readDisabledMap()).sort();
			return ["all", ...disabledIds]
				.filter((id) => id.toLowerCase().startsWith(prefix))
				.map((id) => ({
					value: id,
					label: id,
					description: id === "all" ? "re-enable every disabled model" : "disabled by hand",
				}));
		},
		handler: async (args, ctx) => {
			const target = args.trim();
			const disabled = readDisabledMap();
			const disabledIds = Object.keys(disabled).sort();
			if (target.length === 0) {
				await ctx.ui.notify(
					`switchback-enable: name a model address or "all"\ndisabled by hand:\n${
						disabledIds.length === 0 ? "  (none)" : disabledIds.map((id) => `  ${id}`).join("\n")
					}`,
					"info",
				);
				return;
			}
			if (target.toLowerCase() === "all") {
				const count = clearDisabled();
				await ctx.ui.notify(
					count === 0
						? "switchback: no models were disabled"
						: `switchback: re-enabled ${count} disabled model(s)`,
					"info",
				);
				return;
			}
			const address =
				matchAddress(disabledIds, target) ??
				matchAddress(configuredFallbacks(safeLoadForCommand(pi, secrets).config), target);
			if (address === undefined) {
				await ctx.ui.notify(
					`switchback: ${JSON.stringify(target)} is not a configured fallback and was not disabled`,
					"warning",
				);
				return;
			}
			const changed = enableModel(address);
			await ctx.ui.notify(
				changed ? `switchback: re-enabled ${address}` : `switchback: ${address} was not disabled`,
				"info",
			);
		},
	});

	// `/switchback-config` - interactive editor for the switchback.yaml layers:
	// virtual models, fallback order, decision models, encrypted API-key secrets
	// and the debug flag. Each action is validated through the loader's single
	// gate (`validateFileConfig`) and saved immediately, so the
	// file on disk always holds the last good config; a failed action reverts.
	pi.registerCommand("switchback-config", {
		description: "Interactively configure virtual models, fallbacks, decision models, API keys and debug",
		handler: async (_args, ctx) => {
			await runDialogue(
				{
					hasUI: ctx.hasUI,
					ui: ctx.ui,
					// The searchable catalog picker is TUI-only; other modes fall back to
					// the dialogue's text prompt for `provider/id`.
					...(ctx.mode === "tui"
						? {
								pickModel: (title: string, current: readonly string[]) =>
									pickModelInteractive(ctx, title, current),
							}
						: {}),
					classifierProviders: classifierProvidersFrom(ctx.modelRegistry),
					probeClassifier: (decisionModel: DecisionModelConfig) => probeClassifierConfig(ctx, decisionModel),
				},
				secrets,
			);
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

	// `/switchback-model` sets the routed model directly: pick one of the current
	// virtual model's fallbacks from a list (or clear the pin). Same pin as
	// `/switchback-next`, without cycling through the list.
	pi.registerCommand("switchback-model", {
		description: "Choose the model the current switchback model routes to (or clear the pin)",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				await ctx.ui.notify("/switchback-model needs a UI-capable context (TUI or RPC)", "warning");
				return;
			}
			const current = ctx.model;
			if (current === undefined || current.provider !== SWITCHBACK_PROVIDER) {
				await ctx.ui.notify(
					`switchback-model only works on a switchback model; current is "${current?.provider ?? "(none)"}/${current?.id ?? ""}"`,
					"warning",
				);
				return;
			}
			const virtualId = `${current.provider}/${current.id}`;
			const reloaded = safeLoadForCommand(pi, secrets);
			const modelConfig = findModelConfig(reloaded.config, virtualId);
			const autoLabel = "(auto - clear the pin, route by stickiness and preference)";
			const currentPin = getPinnedModel(virtualId);
			const labels = modelConfig.fallbacks.map((id) => (id === currentPin ? `${id}  (current pin)` : id));
			const choice = await ctx.ui.select(`${virtualId} routes to`, [autoLabel, ...labels]);
			if (choice === undefined) return;
			if (choice === autoLabel) {
				setPinnedModel(virtualId, null);
				await ctx.ui.notify(`${virtualId}: pin cleared`, "info");
				return;
			}
			const picked = modelConfig.fallbacks[labels.indexOf(choice)];
			if (picked === undefined) return;
			setPinnedModel(virtualId, picked);
			await ctx.ui.notify(`${virtualId}: routes to ${picked}`, "info");
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
				lines.push(
					`  ${shortHash(hash)}  ${e.provider}/${e.model}  ${clsOrReason}  count=${e.count}  last=${lastMin}m ago  action=${e.action}${annotated}`,
				);
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
				await ctx.ui.notify(
					`class must be one of: ${["quota", "auth", "transient", "overflow", "unknown"].join(", ")}`,
					"warning",
				);
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
/**
 * The dialogue's searchable model picker: every chat model in pi's catalog
 * (switchback's own virtual models excluded), marked ready / no-credentials and
 * with the ones already in the edited list flagged. Built from pi's TUI toolkit
 * - the same components pi's own pickers use (see `src/model-picker.ts`).
 */
function pickModelInteractive(
	ctx: ExtensionContext,
	title: string,
	current: readonly string[],
): Promise<string | undefined> {
	const models = ctx.modelRegistry.getModelsOfType("chat").filter((model) => model.provider !== SWITCHBACK_PROVIDER);
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) =>
		createModelPicker({
			tui,
			theme,
			keybindings,
			done,
			title,
			source: {
				models,
				current,
				ready: (provider) => ctx.modelRegistry.getProviderAuthStatus(provider).configured,
			},
		}),
	);
}

/**
 * Classifier endpoints for the decision-model wizard: every provider pi reports
 * a classifier model for (with its own display name and base URL), plus the local
 * SystemOne servers with their environment-derived defaults. switchback keeps no
 * provider table of its own.
 */
function classifierProvidersFrom(registry: ExtensionContext["modelRegistry"]) {
	return buildClassifierProviders(
		registry.getRegisteredProviderIds().map((id) => {
			const provider = registry.getProvider(id);
			return {
				id,
				name: registry.getProviderDisplayName(id) || provider?.name || id,
				...(provider?.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
				classifiers: registry
					.getModelsOfType("classifier", id)
					.map((model) => ({ id: model.id, api: model.api })),
				// Chat models pi already owns under this id: registering a direct
				// endpoint here would replace them (pi's `applyExtension`).
				chatModels: registry.getModelsOfType("chat", id).length,
			};
		}),
	);
}

/**
 * Probe a classifier the dialogue just configured: a local `baseUrl` goes
 * through switchback's own transport (the registered provider only appears after
 * a restart), a catalog classifier through pi's registry.
 */
async function probeClassifierConfig(ctx: ExtensionContext, decisionModel: DecisionModelConfig): Promise<ProbeResult> {
	if (decisionModel.baseUrl !== undefined) {
		return probeLocalClassifier({
			baseUrl: decisionModel.baseUrl,
			apiKey: decisionModel.apiKey ?? decisionModel.provider,
			provider: decisionModel.provider,
			id: decisionModel.id,
		});
	}
	const handle = ctx.modelRegistry.findOfType("classifier", decisionModel.provider, decisionModel.id);
	if (handle === undefined) {
		return {
			ok: false,
			answers: {},
			missing: ["choice", "score", "noul"],
			ms: 0,
			error: `pi has no classifier "${decisionModel.provider}/${decisionModel.id}" in its catalog`,
		};
	}
	const started = Date.now();
	const result = await ctx.modelRegistry.classify(handle, buildProbeContext());
	return summarizeProbe(result, Date.now() - started);
}

function debugFlag(value: string | undefined): boolean | undefined {
	const v = value?.trim().toLowerCase();
	if (v === undefined || v === "") return undefined;
	return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * Load the config; surfaces a no-config warning when no file is found rather than
 * throwing (commands run at any time, not just during routing).
 */
function safeLoad(
	pi: ExtensionAPI,
	secrets?: { get(name: string): string | undefined },
): {
	config: ResolvedSwitchbackFileConfig;
	source: string;
} {
	try {
		return loadConfig(secrets);
	} catch (error) {
		const message =
			error instanceof ConfigInvalidError
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

function safeLoadForCommand(
	pi: ExtensionAPI,
	secrets?: { get(name: string): string | undefined },
): {
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

// Every configured fallback address across a config file, first-seen order and
// deduplicated: the vocabulary the disable/enable commands accept.
function configuredFallbacks(config: ResolvedSwitchbackFileConfig): ModelId[] {
	const seen = new Set<ModelId>();
	for (const model of config.models) for (const id of model.fallbacks) seen.add(id);
	return [...seen];
}

// Commands are typed by hand, so address matching ignores case (the unblock
// command works the same way). Returns the canonical configured spelling.
function matchAddress(addresses: readonly ModelId[], argument: string): ModelId | undefined {
	const wanted = argument.trim().toUpperCase();
	if (wanted.length === 0) return undefined;
	return addresses.find((id) => id.toUpperCase() === wanted);
}

interface ParsedAnnotateArgs {
	hash: string;
	class: string;
	note?: string;
}

function parseAnnotateArgs(args: string): ParsedAnnotateArgs | undefined {
	const parts = args
		.trim()
		.split(/\s+/u)
		.filter((p) => p.length > 0);
	if (parts.length < 2) return undefined;
	const [maybeHash, maybeClass, ...rest] = parts;
	if (maybeHash === undefined || maybeClass === undefined) return undefined;
	const hashOk = /^[0-9a-f]{4,}$/u.test(maybeHash);
	if (!hashOk) return undefined;
	const note = rest.length > 0 ? rest.join(" ") : undefined;
	return note === undefined ? { hash: maybeHash, class: maybeClass } : { hash: maybeHash, class: maybeClass, note };
}
