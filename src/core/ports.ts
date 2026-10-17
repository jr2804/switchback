/**
 * The host boundary: everything the switchback core reads from the harness it runs in.
 *
 * The `src/core/` modules depend on the interfaces named here; a host adapter
 * supplies objects that satisfy them. pi satisfies all of them structurally
 * today - `ctx.modelRegistry` is both an `AvailabilityPort` and a
 * `ClassifierPort`, and pi model ids are `provider/id` strings - so nothing about
 * pi's behaviour changes, and the planned OpenCode adapter satisfies the same
 * shapes (see `.agents/plans/opencode-support.md`).
 *
 * Three rules keep this file honest:
 *
 *  - **Narrow.** A port names the slice the core actually reads, never the whole
 *    host object. `ModelRegistryPort` is `find()` alone, which is what lets a
 *    catalog registry that is not pi's satisfy it.
 *  - **One home.** A port is declared here and imported from here. A module that
 *    re-declares a boundary it does not own is a bug (`.agents/POLICIES.md` ->
 *    DOX authoring: reference, don't restate).
 *  - **Consumed, not imagined.** A port arrives with the seam that uses it. The
 *    reasoning-level and state-directory seams are `switchback-wix.3` and
 *    `switchback-wix.5`; until those land, a level or a path is read directly,
 *    and declaring a port for it here would be a stub, not a boundary.
 *
 * The `@earendil-works/pi-ai` imports below are types only: the core never
 * imports a host *value*. The strategy for these remaining type dependencies is
 * `switchback-wix.4`.
 */

import type {
	Api,
	ClassifierApi,
	ClassifierContext,
	ClassifierModel,
	ClassifierResult,
	Model,
} from "@earendil-works/pi-ai";

/** Minimum slice of the host model catalog needed to resolve a `provider/id` entry. */
export interface ModelRegistryPort {
	/** Resolve one catalog entry. `undefined` means this host does not offer the id. */
	find(provider: string, modelId: string): Model<Api> | undefined;
}

/** Per-route availability resolution: catalog lookup plus the provider's credential state. */
export interface AvailabilityPort {
	find(provider: string, modelId: string): Model<Api> | undefined;
	hasConfiguredAuth(model: Model<Api>): boolean;
	getProviderAuthStatus(provider: string): { configured: boolean; source?: string; label?: string };
}

/**
 * The host's SystemOne classifier, reached by type so a real transport can stand in.
 *
 * Keeping it narrow lets a test supply a real classifier transport (llama.cpp /
 * TypeSafe) behind a small shim without constructing a full host registry. pi's
 * `ctx.modelRegistry` satisfies it structurally.
 */
export interface ClassifierPort {
	findOfType(type: "classifier", provider: string, id: string): ClassifierModel<ClassifierApi> | undefined;
	classify(model: ClassifierModel<ClassifierApi>, context: ClassifierContext): Promise<ClassifierResult>;
}

/** UI notification sink. Called once per `no-classifier` decision. */
export type NotifyPort = (message: string, type: "info" | "warning" | "error") => void;

/**
 * What the router reads from the host: the catalog and credential state it
 * resolves the fallback list against, plus the classifier that decides error
 * classes and reasoning levels. The intersection is the port - it is not a new
 * ability, just the one name the router and the dispatch step share.
 */
export type RouterRegistryPort = AvailabilityPort & ClassifierPort;
