/**
 * Shared types for switchback.
 */

/** A physical-model preference as "provider/id" (e.g. "zai/glm-4.7"). */
export type ModelId = string;

/** Jev classifier configuration (locked at the top of the user config). */
export interface JevConfig {
	/** Provider id under which the classifier model is registered (e.g. "typesafe"). */
	provider: string;
	/** Classifier model id (e.g. "jev-latest"). */
	id: string;
	/**
	 * Optional direct endpoint. When set, switchback registers this classifier
	 * itself instead of looking it up in pi's catalog - for a local System One
	 * server such as Ollama v0.35+ (`http://localhost:11434/v1`). This is
	 * deliberately outside pi's normal provider/model configuration: exactly one
	 * decision model, configured here, used only by this extension.
	 */
	baseUrl?: string;
	/** Wire API for the direct endpoint. Only "typesafe-system-one" is supported today. */
	api?: string;
	/** Bearer token for the direct endpoint. A local server ignores it, but the transport requires a non-empty value. */
	apiKey?: string;
}

/** A single switchback virtual-model definition. */
export interface SwitchbackConfig {
	/** "provider/id" of the virtual model. Must be the same as the registered virtual model. */
	id: string;
	/** Display name for the virtual model. */
	name: string;
	/** Ordered preference of physical models ("provider/id"). First entry is the preferred model. */
	fallbacks: ModelId[];
	/** Jev classifier used for error classification. When absent, the router reports and blind-cycles (there is no heuristic fallback). */
	jev?: JevConfig;
}

/** Top-level switchback configuration. */
export interface SwitchbackFileConfig {
	models: SwitchbackConfig[];
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

/** Per-session router state. Persisted on the session branch by pi. */
export interface SwitchbackState {
	/** "provider/id" of the model the session is currently routed to. Undefined only before the first route. */
	current: ModelId;
	/** Epoch ms at which the most recent switch happened. Undefined before any switch. */
	lastSwitchAtMs?: number;
	/** Number of transient retries on the current model. Reset on every switch to a new model. */
	transientRetries: number;
	/** True when the single-model-degraded warning has been emitted this session. */
	degradedWarned?: boolean;
}

/** Cross-session blocked-until map. Keyed by "provider/id", value is epoch ms. */
export type BlockedMap = Record<ModelId, number>;

/** Reason for a route() decision. */
export type RouteReason = "user" | "continuation" | "retry" | "direct";
