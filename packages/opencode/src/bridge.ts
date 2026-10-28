/**
 * The plugin ⇄ provider-package handoff.
 *
 * OpenCode loads a provider package (`module.model(modelID, settings)`) and a
 * plugin (`Plugin.define`) as separate module instances, and neither can import
 * the other: the package is resolved by the host's own loader, the plugin by
 * the plugin loader. A provider package also has no host context - it cannot
 * see the catalog, credentials, or switchback.yaml - while the plugin has all
 * three. The bridge is the one channel between them: a registry keyed by a
 * `Symbol.for`, so duplicate module instances of either side still find the
 * same channel.
 *
 * Ownership:
 *   - the PLUGIN publishes a `SwitchbackBridge` during `setup()` (config,
 *     catalog, credentials, notifications, and the routing decision itself);
 *   - the PROVIDER PACKAGE (`src/route.ts`) reads it per request to run the
 *     fallback cascade. Without a published bridge the package fails every
 *     request with a visible "plugin not loaded" error rather than guessing.
 *
 * Nothing here imports the host: both sides already share the host's
 * `@opencode/ai` and `effect` copies from the install tree.
 */

import type { ThinkingLevelId } from "switchback-core/ports.ts";
import type { RouteReason, SwitchbackState } from "switchback-core";

/** Connection settings for one physical model, resolved by the plugin. */
export interface PhysicalSettings {
	readonly apiKey?: string;
	readonly baseURL?: string;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: Readonly<Record<string, unknown>>;
}

/**
 * One physical model the cascade can dispatch to, fully resolved: the builtin
 * provider package that serves it, the model id to construct, and the live
 * connection settings (credential included) as of the last refresh.
 */
export interface PhysicalEntry {
	/** Config address of the model (`provider/modelID`). */
	readonly modelId: string;
	/** Provider package specifier the host itself uses, e.g. `@opencode/ai/providers/zai-coding-plan/chat`. */
	readonly providerModule: string;
	/** Model id passed to the provider package's `model()`. */
	readonly modelID: string;
	readonly name: string;
	readonly settings: PhysicalSettings;
	readonly contextWindow: number;
}

/** One routing decision the provider package asks the plugin for. */
export interface RouteCall {
	/** The configured chain this virtual model serves (the model id: `auto`, `auto-flash`, ...). */
	readonly chainId: string;
	/** Stable per-conversation key (`x-opencode-session-id`, falling back to the cache affinity). */
	readonly sessionKey: string;
	readonly reason: RouteReason;
	/** The reasoning category the user selected on the virtual model (its variant), when any. */
	readonly level?: ThinkingLevelId;
	/** For `reason: "retry"`: the model that failed and the error text OpenCode surfaced. */
	readonly failed?: { readonly modelId: string; readonly message: string };
}

export type RouteAnswer =
	| {
			readonly status: "ok";
			/** The physical model to dispatch to (`provider/modelID`). */
			readonly current: string;
			/** The level the dispatch settled on (after classifier resolution). */
			readonly level: ThinkingLevelId;
			/** The post-decision router state, keyed by `sessionKey` on the plugin side. */
			readonly state: SwitchbackState;
	  }
	| { readonly status: "config-invalid"; readonly message: string }
	| { readonly status: "exhausted"; readonly message: string };

/**
 * What the provider package can ask of the plugin. Everything that needs host
 * context or shared state lives behind this interface; the package stays a
 * thin dispatcher.
 */
export interface SwitchbackBridge {
	/** The routing decision for one attempt. Mirrors pi's `route()` callback. */
	route(call: RouteCall): Promise<RouteAnswer>;
	/** The chain's physical entries with live settings; re-resolved per call. */
	entries(chainId: string): Promise<readonly PhysicalEntry[]>;
	/** Chat-side notice. Best effort; must never throw. */
	notify(sessionKey: string, message: string, type: "info" | "warning" | "error"): void;
	/** True when `debug:` is set in the shared config. */
	debug(): boolean;
}

const BRIDGE_KEY = Symbol.for("switchback.opencode.bridge");

/** Publish the plugin-side bridge. Called once per plugin `setup()`. */
export function publishBridge(bridge: SwitchbackBridge): void {
	(globalThis as Record<symbol, unknown>)[BRIDGE_KEY] = bridge;
}

/** The live bridge, or undefined when the plugin has not loaded in this process. */
export function readBridge(): SwitchbackBridge | undefined {
	return (globalThis as Record<symbol, unknown>)[BRIDGE_KEY] as SwitchbackBridge | undefined;
}

/** Clear the bridge slot (plugin reload/dispose paths and tests). */
export function clearBridge(): void {
	delete (globalThis as Record<symbol, unknown>)[BRIDGE_KEY];
}
