/**
 * pi's answer to the core's `ThinkingSupportPort`.
 *
 * The port exists so `switchback-core` can settle a reasoning level without
 * importing pi's level rules. Those rules are `getSupportedThinkingLevels` and
 * `clampThinkingLevel` from `@earendil-works/pi-ai`, and they take pi's own
 * `Model` - so this adapter re-resolves the physical model from pi's registry by
 * `{provider, id}` rather than casting a core shape into a pi model. A model pi
 * no longer knows about is reported as offering `"off"` only, which is what
 * pi itself would clamp to.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { HostModel, ThinkingLevelId, ThinkingSupportPort } from "switchback-core/ports.ts";

/** The one registry read the level rules need; pi's registry satisfies it. */
export interface PiModelLookup {
	find(provider: string, modelId: string): Model<Api> | undefined;
}

/** Bind pi's reasoning-level rules to the registry that answers for a request. */
export function piThinkingSupport(registry: PiModelLookup): ThinkingSupportPort {
	const resolve = (model: HostModel) => registry.find(model.provider, model.id);
	return {
		supportedLevels: (model) => {
			const found = resolve(model);
			return found === undefined ? ["off"] : getSupportedThinkingLevels(found);
		},
		clamp: (model, level: ThinkingLevelId) => {
			const found = resolve(model);
			return found === undefined ? "off" : clampThinkingLevel(found, level);
		},
	};
}
