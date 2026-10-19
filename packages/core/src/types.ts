/**
 * Shared types for switchback.
 */

/** A physical-model preference as "provider/id" (e.g. "zai/glm-4.7"). */
export type ModelId = string;

/**
 * A decision-model address as "provider/model-id" - the same shape as a
 * fallback entry, e.g. "typesafe/jev-latest" or "ollama/tev1:0.8b".
 */
export type DecisionModelId = string;

/**
 * A decision model after address resolution.
 *
 * With a `baseUrl` the host drives the SystemOne endpoint directly (both pi and
 * OpenCode can do this). Without one the host resolves the address from its own
 * classifier catalog - pi has one, OpenCode does not, so a catalog-only address
 * stays an explicit "no classifier" cycle there.
 */
export interface DecisionModelConfig {
	/** Provider id (e.g. "typesafe", "ollama", "openrouter"). */
	provider: string;
	/** Model id within that provider (e.g. "jev-latest", "tev1:0.8b"). */
	id: string;
	/** Direct SystemOne endpoint. When set, no catalog lookup happens. */
	baseUrl?: string;
	/** Bearer token for the direct endpoint, or `secret:<name>` referencing a secret store. */
	apiKey?: string;
}

/**
 * Connection details for one decision-model address - a `decisionModels:` map
 * value. `baseUrl` and `apiKey` come as a pair: a direct endpoint needs a bearer
 * token even when the endpoint ignores it (`apiKey: local`).
 */
export interface DecisionModelEntry {
	/** Direct SystemOne endpoint (http/https). */
	baseUrl?: string;
	/** Bearer token, or `secret:<name>`. Required with `baseUrl`. */
	apiKey?: string;
}

/**
 * A config entry after address resolution: `decisionModel` is always the
 * provider/id descriptor. This is what the router and the extension consume; the
 * address form exists only in the YAML file and the config editor.
 */
export type ResolvedSwitchbackConfig = Omit<SwitchbackConfig, "decisionModel"> & {
	decisionModel?: DecisionModelConfig;
};

/** A config file after aggregation and address resolution. */
export interface ResolvedSwitchbackFileConfig {
	models: ResolvedSwitchbackConfig[];
	/** Resolved `decisionModels:` entries, keyed by their address. */
	decisionModels?: Record<DecisionModelId, DecisionModelConfig>;
	debug?: boolean;
}

/**
 * When a long-idle session should abandon its sticky model for the head of the
 * list (`idleReset:`). `never` is the default; a duration is a fixed threshold;
 * `classifier` asks the decision model (see `src/idle.ts`).
 */
export type IdleResetConfig = "never" | "30m" | "1h" | "2h" | "3h" | "5h" | "12h" | "24h" | "classifier";

/** A single switchback virtual-model definition. */
export interface SwitchbackConfig {
	/** "provider/id" of the virtual model. Must be the same as the registered virtual model. */
	id: string;
	/** Display name for the virtual model. */
	name: string;
	/** Ordered preference of physical models ("provider/id"). First entry is the preferred model. */
	fallbacks: ModelId[];
	/**
	 * Decision model as "provider/model-id". Connection details for direct
	 * endpoints live in the top-level `decisionModels:` map under the same
	 * address. Absent: report and blind-cycle.
	 */
	decisionModel?: DecisionModelId;
	/** Return to the head of the list after this much idle time (default `never`). */
	idleReset?: IdleResetConfig;
}

/** Top-level switchback configuration. */
export interface SwitchbackFileConfig {
	models: SwitchbackConfig[];
	/**
	 * Connection details for decision-model addresses that need a direct
	 * SystemOne endpoint, keyed by the same "provider/model-id" address a chain
	 * names in `decisionModel:`.
	 */
	decisionModels?: Record<DecisionModelId, DecisionModelEntry>;
	/**
	 * Emit one diagnostics notification per model switch (the classifier's verdict
	 * and how the requested reasoning category resolved against the activated
	 * model). The `SWITCHBACK_DEBUG=1` environment variable overrides this.
	 */
	debug?: boolean;
}

/** Classification of a failed request's error message. */
export type ErrorClass = "quota" | "auth" | "transient" | "overflow" | "unknown";

/** Scope of a quota or auth error, when known. */
export type ErrorScope = "model" | "account" | "ip" | "unknown";

/** Result of classifying one failed request. */
export interface ClassifiedError {
	class: ErrorClass;
	/** Best-effort reset time in epoch ms. Undefined when the error is not quota or no reset time is reported. */
	resetAtMs?: number;
	scope: ErrorScope;
	/** Original error message, preserved for logging. */
	raw: string;
	/**
	 * Where the classification came from. Default "classifier" (a live Jev call).
	 * "annotation" means the result came from the user's Tier 2b annotation cache
	 * (`/switchback-annotate`). "structured" means pi's typed stopReason branch
	 * fired (overflow only). Routing and recording use this to label the decision
	 * source honestly; the values are NEVER mixed in a way that bypasses the
	 * classifier - the annotation cache only fires on user-confirmed entries.
	 */
	source?: "classifier" | "annotation" | "structured";
}

/** Availability classification for a configured fallback. Per design doc step 8. */
export type Availability = "effective" | "greyed-model-not-in-catalog" | "greyed-provider-unavailable";

/** Per-entry resolution of a configured fallback. */
export interface ResolvedEntry {
	id: ModelId;
	availability: Availability;
	reason?: string;
}

/** Effective fallback list as resolved against the current model registry. */
export interface ResolvedFallbacks {
	entries: ResolvedEntry[];
	effectiveCount: number;
	greyedCount: number;
}

/**
 * Per-session router state. Persisted on the session branch by pi.
 *
 * The session stays on `current` until that model is blocked or leaves the catalog
 * (see `decide`), so this is the router's memory of where it already moved the
 * session — not a hint it is free to override on the next turn.
 */
export interface SwitchbackState {
	/** "provider/id" of the model the session is currently routed to. Undefined only before the first route. */
	current: ModelId;
	/** Number of transient retries on the current model. Reset on every switch to a new model. */
	transientRetries: number;
	/** True when the single-model-degraded warning has been emitted this session. */
	degradedWarned?: boolean;
	/**
	 * Models that failed in the current cascade of retries (since the last user,
	 * direct or continuation route). They are never handed back within the same
	 * cascade; see `chainWith()` in routing.ts.
	 */
	chainFailed?: ModelId[];
}

/** Cross-session blocked-until map. Keyed by "provider/id", value is epoch ms. */
export type BlockedMap = Record<ModelId, number>;

/** Reason for a route() decision. */
export type RouteReason = "user" | "continuation" | "retry" | "direct";
