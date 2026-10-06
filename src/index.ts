/**
 * Barrel re-export for tests and downstream consumers. The entry `index.ts` imports
 * the same modules directly to keep its surface small; this barrel exists so tests
 * can `import { decide, ... } from "..//src/index.ts"` without enumerating modules.
 */

export { decide, buildRoute, ConfigInvalidError, MAX_TRANSIENT_RETRIES } from "./routing.ts";
export type { Decision, DecisionOutcome, NotifyFn, RouteInputs, RouterRegistry } from "./routing.ts";
export { classifyError, PROMPT_VERSION, callClassifier, readChoice, CLASSIFIER_TIMEOUT_MS } from "./classify.ts";
export type { ClassificationResult, NoClassifierReason, ClassifierCallResult, ClassifierRegistry } from "./classify.ts";
export { chooseThinkingLevel, availableCategories, supportedLevels, SWITCHBACK_THINKING_LEVELS, THINKING_PROMPT_VERSION } from "./thinking.ts";
export type { ThinkingLevelChoice, ThinkingLevelContext, ThinkingLevelSource } from "./thinking.ts";
export { blockModel, isBlocked, readBlockedMap, unblockModel, stateFilePath } from "./state.ts";
export {
	readCrashMap,
	recordCrash,
	lookupCrash,
	findCrashByShortHash,
	annotateCrash,
	hashSample,
	shortHash,
	crashesFilePath,
	isValidAnnotationClass,
	CrashError,
} from "./crashes.ts";
export type { CrashEntry, CrashMap, CrashAction, CrashVerdict, CrashAnnotation, RecordCrashInput } from "./crashes.ts";
export { createSecretStore, secretsFilePath, powershellDpapi, SecretsError } from "./secrets.ts";
export type { SecretStore, Dpapi } from "./secrets.ts";
export { loadConfig, findModelConfig, DEFAULT_CONFIG, SWITCHBACK_PROVIDER, SWITCHBACK_VIRTUAL_ID, ConfigError, piConfigDir, piSwitchbackDir } from "./config.ts";
export type { SwitchbackConfig, SwitchbackFileConfig, JevConfig } from "./config.ts";
export { loadSimulate, getScenario, simulateRetry, SimulateError } from "./simulate.ts";
export type { SimulateConfig, SimulateResult } from "./simulate.ts";
export { resolveFallbacks, effectiveIds, pickNextEffective } from "./availability.ts";
export type { AvailabilityRegistry } from "./availability.ts";
export type {
	Availability,
	BlockedMap,
	ClassifiedError,
	ErrorClass,
	ErrorScope,
	ModelId,
	ResolvedEntry,
	ResolvedFallbacks,
	RouteReason,
	SwitchbackState,
} from "./types.ts";
