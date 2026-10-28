/**
 * Host-side catalog helpers: OpenCode's model records reduced to the ports the
 * core router reads, plus the provider-module mapping the cascade uses to
 * construct a physical model.
 *
 * Moved verbatim in role from the option-B plugin's `index.ts` so both the
 * plugin (registry construction, commands) and the bridge share one
 * implementation.
 */

import type { HostModel, AvailabilityPort } from "switchback-core";
import type { ThinkingSupportPort } from "switchback-core/ports.ts";
import { SWITCHBACK_THINKING_LEVELS } from "switchback-core";

/** What the adapter reads off a model catalog entry, narrowed to consumed fields. */
export interface CatalogModel {
	readonly id: string;
	readonly modelID: string;
	readonly providerID: string;
	readonly name: string;
	readonly enabled: boolean | undefined;
	readonly limit: { readonly context: number } | undefined;
	readonly capabilities?: unknown;
	readonly package?: string | undefined;
	readonly settings?: Readonly<Record<string, unknown>> | undefined;
}

/** The catalog's reasoning capability bit, read defensively off the host record. */
function isNonReasoning(info: CatalogModel | undefined): boolean {
	const capabilities = info?.capabilities;
	if (capabilities === null || typeof capabilities !== "object") return false;
	return (capabilities as { reasoning?: unknown }).reasoning === false;
}

/**
 * The availability port over OpenCode's model catalog. The catalog is re-read
 * per decision (one `ctx.model.list()` call) rather than snapshotted: OpenCode
 * edits its own catalog live and the list never lives longer than one
 * classification.
 */
export function catalogPort(catalog: readonly CatalogModel[]): AvailabilityPort {
	return {
		find: (provider, modelId) => {
			const info = findInCatalog(catalog, provider, modelId);
			return info === undefined || info.enabled === false ? undefined : hostModel(info);
		},
		hasConfiguredAuth: (model) => findInCatalog(catalog, model.provider, model.id) !== undefined,
		getProviderAuthStatus: (provider) =>
			catalog.some((info) => info.providerID === provider)
				? { configured: true }
				: { configured: false, label: `no enabled models for provider "${provider}" in the OpenCode catalog` },
	};
}

/** A catalog entry gets a second look when it carries OpenCode's own record type. */
function hostModel(info: CatalogModel): HostModel {
	return {
		provider: info.providerID,
		id: info.modelID,
		name: info.name,
		// OpenCode's catalog carries no wire-API name; the core port keeps the
		// field for pi-shaped records and no core switchback step reads it here.
		api: "opencode",
		contextWindow: info.limit?.context ?? 0,
	};
}

/** "provider/id" to its halves; undefined for anything else config could hold. */
export function splitModelAddress(serialized: string): { provider: string; modelId: string } | undefined {
	const slash = serialized.indexOf("/");
	if (slash <= 0 || slash === serialized.length - 1) return undefined;
	return { provider: serialized.slice(0, slash), modelId: serialized.slice(slash + 1) };
}

/**
 * Resolve a catalog entry by provider plus model id. OpenCode's catalog
 * entries carry both a bare (`modelID`) and a provider-qualified (`id`)
 * address; switchback's config speaks "provider/modelID", and the OpenCode
 * surfaces so far (the Model.Ref the retry hook gets) have historically been
 * bare - so both forms resolve.
 */
export function findInCatalog(
	catalog: readonly CatalogModel[],
	provider: string,
	modelId: string,
): CatalogModel | undefined {
	const bare = splitModelAddress(modelId)?.modelId ?? modelId;
	return catalog.find(
		(info) =>
			info.providerID === provider && (info.modelID === modelId || info.modelID === bare || info.id === modelId),
	);
}

/**
 * OpenCode's reasoning-level rules, derived from its own model record.
 *
 * pi passes pi-ai's `getSupportedThinkingLevels`/`clampThinkingLevel` through;
 * OpenCode has no per-model level map, so the capability bit decides: a
 * reasoning model offers switchback's whole category scale, anything else
 * offers `off`. `clamp` keeps the requested category when supported and
 * otherwise steps down the scale - the same contract pi-ai implements for
 * models with narrower maps.
 */
export function opencodeThinkingSupport(catalog: readonly CatalogModel[]): ThinkingSupportPort {
	return {
		supportedLevels: (model) => {
			const info = findInCatalog(catalog, model.provider, model.id);
			if (isNonReasoning(info)) return ["off"];
			return [...SWITCHBACK_THINKING_LEVELS];
		},
		clamp: (model, level) => {
			const supported = opencodeThinkingSupport(catalog).supportedLevels(model);
			if (supported.includes(level)) return level;
			const index = SWITCHBACK_THINKING_LEVELS.lastIndexOf(level);
			for (let i = Math.max(0, index); i >= 0; i--) {
				const candidate = SWITCHBACK_THINKING_LEVELS[i];
				if (candidate !== undefined && supported.includes(candidate)) return candidate;
			}
			return "off";
		},
	};
}

/**
 * Map a catalog model's `package` to the builtin provider module the cascade
 * constructs it with. Host-bundled `@opencode/ai/providers/*` specifiers pass
 * through; every AI-SDK or npm package OpenCode bridges itself resolves to the
 * builtin `openai-compatible` module with the same connection settings - those
 * packages exist precisely to serve OpenAI-shaped endpoints.
 */
export function providerModuleFor(pkg: string | undefined): string {
	if (typeof pkg === "string" && pkg.startsWith("@opencode/ai/providers/")) return pkg;
	return "@opencode/ai/providers/openai-compatible";
}
