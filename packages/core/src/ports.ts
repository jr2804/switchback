/**
 * The host boundary: everything the switchback core reads from the harness it runs in.
 *
 * The core modules depend on the interfaces named here; a host adapter
 * supplies objects that satisfy them. pi satisfies all of them today -
 * `ctx.modelRegistry` is both an `AvailabilityPort` and a `ClassifierPort`, and
 * pi model ids are `provider/id` strings - so nothing about pi's behaviour
 * changes, and the OpenCode adapter satisfies the same shapes (see
 * `.agents/plans/opencode-support.md`).
 *
 * Four rules keep this file honest:
 *
 *  - **Narrow.** A port names the slice the core actually reads, never the whole
 *    host object. `ModelRegistryPort` is `find()` alone, which is what lets a
 *    catalog registry that is not pi's satisfy it.
 *  - **One home.** A port is declared here and imported from here. A module that
 *    re-declares a boundary it does not own is a bug (`.agents/POLICIES.md` ->
 *    DOX authoring: reference, don't restate).
 *  - **Consumed, not imagined.** A port arrives with the seam that uses it. Until
 *    a seam lands, the module behind it reads directly; declaring a port early
 *    would be a stub, not a boundary.
 *  - **Host-neutral vocabulary.** `HostModel` and `ThinkingLevelId` are the
 *    core's own names for the two host concepts it reads. A host that offers a
 *    richer shape (pi's `Model<Api>` carries cost, limits and a thinking-level
 *    map) is still assignable, because a port only ever asks for the fields the
 *    core reads.
 *
 * The remaining `@earendil-works/pi-ai` imports below are types only: the core
 * never imports a host *value*. `ClassifierContext` and `ClassifierResult` stay
 * because they are the wire shape of a classifier call, not a host object.
 */

import type { ClassifierContext, ClassifierResult } from "@earendil-works/pi-ai";

/**
 * The host's model handle, reduced to the fields the core reads.
 *
 * Deliberately smaller than pi's `Model<Api>` and than OpenCode's model record:
 * a port that asked for the host's own type would make every other host
 * unimplementable. `provider` + `id` are the identity (`provider/id` is how
 * config names a model); `name`, `api` and `contextWindow` are read when a
 * decision is rendered or checked against the current context usage.
 */
export interface HostModel {
	readonly provider: string;
	readonly id: string;
	readonly name: string;
	readonly api: string;
	readonly contextWindow: number;
}

/** Minimum slice of the host model catalog needed to resolve a `provider/id` entry. */
export interface ModelRegistryPort {
	/** Resolve one catalog entry. `undefined` means this host does not offer the id. */
	find(provider: string, modelId: string): HostModel | undefined;
}

/** Per-route availability resolution: catalog lookup plus the provider's credential state. */
export interface AvailabilityPort {
	find(provider: string, modelId: string): HostModel | undefined;
	hasConfiguredAuth(model: HostModel): boolean;
	getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
}

/**
 * The host's SystemOne classifier, reached by type so a real transport can stand in.
 *
 * Keeping it narrow lets a test supply a real classifier transport (llama.cpp /
 * TypeSafe) behind a small shim without constructing a full host registry. pi's
 * `ctx.modelRegistry` satisfies it structurally; the OpenCode adapter satisfies
 * it with switchback's own `systemone.ts` transport.
 */
export interface ClassifierPort {
	findOfType(type: "classifier", provider: string, id: string): HostModel | undefined;
	classify(model: HostModel, context: ClassifierContext): Promise<ClassifierResult>;
}

/** UI notification sink. Called once per `no-classifier` decision. */
export type NotifyPort = (message: string, type: "info" | "warning" | "error") => void;

/** Reasoning levels switchback can ask for. Matches pi's `ModelThinkingLevel`. */
export type ThinkingLevelId = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * The host's reasoning-level rules.
 *
 * pi exposes these as the `@earendil-works/pi-ai` functions
 * `getSupportedThinkingLevels` / `clampThinkingLevel`, which encode each
 * provider's `thinkingLevelMap` semantics. Those two are the only host *values*
 * the core used to import, so they are the one seam a host must implement:
 * pi passes pi-ai's functions through, OpenCode derives the answer from its own
 * model record.
 */
export interface ThinkingSupportPort {
	/** Levels this model can actually be dispatched at, most-to-least capable. */
	supportedLevels(model: HostModel): ThinkingLevelId[];
	/** The nearest dispatchable level to `level` for this model. */
	clamp(model: HostModel, level: ThinkingLevelId): ThinkingLevelId;
}

/**
 * What the router reads from the host: the catalog and credential state it
 * resolves the fallback list against, plus the classifier that decides error
 * classes and reasoning levels. The intersection is the port - it is not a new
 * ability, just the one name the router and the dispatch step share.
 */
export type RouterRegistryPort = AvailabilityPort & ClassifierPort;
