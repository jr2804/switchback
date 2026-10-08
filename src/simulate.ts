/**
 * Simulate mode.
 *
 * The `switchback.simulate` config flag (true|path) replaces real provider error
 * messages with synthetic ones from a fixture file. The router exercises the same
 * classification, blocking, and fallback code path, but no real provider call is
 * made and no real quota is consumed.
 *
 * Fixture format: a JSON file mapping scenario names to error messages:
 *
 *   {
 *     "scenarios": {
 *       "quota-5h-zai":      "429 Too Many Requests: z.ai GLM 5h window exceeded. Resets at 2026-10-04T15:30:00Z.",
 *       "quota-weekly":      "429: weekly token limit exhausted for ollama-cloud. Try again in 1d 2h.",
 *       "auth-failure":      "401 Unauthorized: invalid API key.",
 *       "transient-5xx":     "502 Bad Gateway: upstream timeout.",
 *       "transient-timeout": "Request timed out after 30s.",
 *       "unknown":           "Unexpected response: <html>...</html>"
 *     }
 *   }
 *
 * In simulate mode the router treats the most-recent-fixture-key-named error as
 * the failure message. Tests can rotate scenarios by mutating the file between
 * requests, or by passing a different scenario name into the router.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RouterRegistry } from "./routing.ts";
import { decide, type Decision } from "./routing.ts";
import type { BlockedMap, ModelId, ResolvedSwitchbackConfig } from "./types.ts";

export interface SimulateConfig {
	scenarios: Record<string, string>;
}

const SCENARIO_NOT_FOUND = Symbol("SCENARIO_NOT_FOUND");

export class SimulateError extends Error {
	constructor(message: string) {
		super(`switchback simulate: ${message}`);
		this.name = "SimulateError";
	}
}

/** Load a simulate config from disk. Throws SimulateError on parse or path failure. */
export function loadSimulate(source: string | true): SimulateConfig {
	const path = typeof source === "string" ? resolve(source) : defaultSimulatePath();
	if (!existsSync(path)) {
		throw new SimulateError(`fixture file not found at "${path}"`);
	}
	const text = readFileSync(path, "utf8");
	const raw: unknown = JSON.parse(text);
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new SimulateError(`fixture file "${path}" must be a JSON object`);
	}
	const scenarios = (raw as Record<string, unknown>)["scenarios"];
	if (!scenarios || typeof scenarios !== "object" || Array.isArray(scenarios)) {
		throw new SimulateError(`fixture file "${path}" must have a top-level "scenarios" object`);
	}
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(scenarios as Record<string, unknown>)) {
		if (typeof value !== "string") {
			throw new SimulateError(`scenario "${key}" must be a string error message`);
		}
		out[key] = value;
	}
	if (Object.keys(out).length === 0) {
		throw new SimulateError(`fixture file "${path}" has no scenarios`);
	}
	return { scenarios: out };
}

function defaultSimulatePath(): string {
	return resolve(process.cwd(), "switchback.simulate.json");
}

/** Look up a scenario by name. Returns undefined when not present. */
export function getScenario(config: SimulateConfig, name: string): string | undefined {
	const value = config.scenarios[name];
	return typeof value === "string" ? value : undefined;
}

/** Mark a "scenario not found" for type guards. */
export function scenarioNotFound(): typeof SCENARIO_NOT_FOUND {
	return SCENARIO_NOT_FOUND;
}

/** Type guard helper. */
export function isScenarioNotFound(value: unknown): value is typeof SCENARIO_NOT_FOUND {
	return value === SCENARIO_NOT_FOUND;
}

/** Re-export the symbol for tests that need it. */
export { SCENARIO_NOT_FOUND };

export interface SimulateResult {
	decision: Decision;
	blocked: ModelId | undefined;
	now: number;
}

/**
 * Run the router against a synthetic failed request: builds a fake ModelRouteRequest
 * from the first configured fallback, calls decide() with the synthetic error message,
 * and returns the decision. The `blocked` field reports which model was newly blocked
 * (when applicable) for tests to assert on the account-scoped blocks.json side effect.
 */
export async function simulateRetry(
	scenarioMessage: string,
	modelConfig: ResolvedSwitchbackConfig,
	registry: RouterRegistry,
	inputs: { now?: number; blocked?: BlockedMap; notify?: import("./routing.ts").NotifyFn } = {},
): Promise<SimulateResult> {
	const now = inputs.now ?? Date.now();
	const blocked = inputs.blocked ?? {};
	const firstFallback = modelConfig.fallbacks[0];
	if (firstFallback === undefined) throw new SimulateError("model config has no fallbacks");
	const [provider, id] = firstFallback.split("/");
	if (provider === undefined || id === undefined) throw new SimulateError(`invalid fallback id "${firstFallback}"`);
	const failedModel = registry.find(provider, id);
	if (!failedModel) throw new SimulateError(`fallback "${firstFallback}" not in catalog`);

	const fakeRequest = {
		reason: "retry" as const,
		model: failedModel,
		thinkingLevel: "medium" as const,
		failed: {
			model: failedModel,
			thinkingLevel: "medium" as const,
			// Minimal AssistantMessage shape for classifyError: only errorMessage is read.
			message: {
				role: "assistant" as const,
				content: [],
				api: "openai-completions" as const,
				provider: failedModel.provider,
				model: failedModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "error" as const,
				errorMessage: scenarioMessage,
				timestamp: now,
			},
		},
		messages: [],
		state: { current: firstFallback, transientRetries: 0 },
	};
	const result = await decide("retry", fakeRequest, modelConfig, registry, {
		now,
		blocked,
		simulateErrorMessage: scenarioMessage,
		...(inputs.notify ? { notify: inputs.notify } : {}),
	});
	return { decision: result.decision, blocked: firstFallback, now };
}
