/**
 * Barrel re-export for tests and downstream consumers. The entry `index.ts` imports
 * the same modules directly to keep its surface small; this barrel exists so tests
 * can `import { decide, ... } from "..//src/index.ts"` without enumerating modules.
 */

export { writeFileAtomic, AtomicWriteError } from "./core/atomic-write.ts";
export { decide, type RouteInputs } from "./core/routing.ts";
export { observeUnretriedFailure, assessFailure, MAX_TRANSIENT_RETRIES } from "./core/failure.ts";
export { buildRoute, ConfigInvalidError } from "./build-route.ts";
export type { Decision, DecisionOutcome } from "./core/decision.ts";
export { classifyError, PROMPT_VERSION, callClassifier, readChoice, CLASSIFIER_TIMEOUT_MS } from "./core/classify.ts";
export type { ClassificationResult, NoClassifierReason, ClassifierCallResult } from "./core/classify.ts";
export type { ClassifierPort, ModelRegistryPort, NotifyPort } from "./core/ports.ts";
export {
	chooseThinkingLevel,
	availableCategories,
	supportedLevels,
	SWITCHBACK_THINKING_LEVELS,
	THINKING_PROMPT_VERSION,
} from "./core/thinking.ts";
export type { ThinkingLevelChoice, ThinkingLevelContext, ThinkingLevelSource } from "./core/thinking.ts";
export {
	decideIdleReset,
	formatIdle,
	idleMsSince,
	idleResetThresholdMs,
	isIdleResetDuration,
	lastMessageTimestamp,
	IDLE_CLASSIFIER_FLOOR_MS,
	IDLE_RESET_OPTIONS,
	IDLE_RESET_PROMPT_VERSION,
} from "./core/idle.ts";
export type { IdleResetDecision, IdleResetInput } from "./core/idle.ts";
export {
	fitsContext,
	usableContextTokens,
	chooseContextCandidate,
	CONTEXT_FIT_RESERVE_TOKENS,
	CONTEXT_CANDIDATE_PROMPT_VERSION,
} from "./core/context-fit.ts";
export type { CandidateWindow, ContextCandidateChoice, ContextCandidateInput } from "./core/context-fit.ts";
export { blockModel, isBlocked, readBlockedMap, unblockModel, stateFilePath } from "./core/state.ts";
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
} from "./core/crashes.ts";
export type {
	CrashEntry,
	CrashMap,
	CrashAction,
	CrashVerdict,
	CrashAnnotation,
	RecordCrashInput,
} from "./core/crashes.ts";
export { createSecretStore, secretsFilePath, powershellDpapi, SecretsError } from "./secrets.ts";
export type { SecretStore, Dpapi } from "./secrets.ts";
export {
	loadConfig,
	findModelConfig,
	DEFAULT_CONFIG,
	SWITCHBACK_PROVIDER,
	SWITCHBACK_VIRTUAL_ID,
	ConfigError,
	piConfigDir,
	piSwitchbackDir,
	LOCAL_CLASSIFIER_APIS,
	resolveJevConfig,
	resolveSecretApiKey,
	validateFileConfig,
} from "./core/config.ts";
export type { SwitchbackConfig, SwitchbackFileConfig, JevConfig } from "./core/config.ts";
export type {
	JevRef,
	DecisionModelEntry,
	ResolvedSwitchbackConfig,
	ResolvedSwitchbackFileConfig,
} from "./core/types.ts";
export {
	addDecisionModel,
	addFallback,
	addVirtualModel,
	countDecisionModelReferences,
	defaultLayer,
	globalConfigPath,
	layerExists,
	layerPath,
	loadLayer,
	moveFallback,
	projectConfigPath,
	readLayerConfig,
	removeDecisionModel,
	removeFallback,
	removeVirtualModel,
	renameDecisionModel,
	renameVirtualModel,
	saveLayer,
	setDecisionModel,
	setDebug,
	setFallbacks,
	setVirtualModelName,
	updateDecisionModel,
} from "./core/config-editor.ts";
export type { ConfigLayer, DecisionModelInput, DecisionModelPatch, LoadedLayer } from "./core/config-editor.ts";
export { runDialogue, layerOptionLabel } from "./dialogue.ts";
export { describeJev } from "./dialogue-ui.ts";
export { createModelPicker, buildModelItems, MODEL_PICKER_MAX_VISIBLE } from "./model-picker.ts";
export type { ModelPickerSource, PickerColor, PickerKeybindings, PickerTheme, PickerTui } from "./model-picker.ts";
export {
	buildClassifierProviders,
	classifierBaseUrlNote,
	defaultDecisionModelName,
	directEndpointWouldClobber,
} from "./core/classifier-catalog.ts";
export type {
	ClassifierModelSummary,
	ClassifierProviderOption,
	ClassifierProviderSource,
} from "./core/classifier-catalog.ts";
export {
	buildProbeContext,
	formatProbeReport,
	missingProbeShapes,
	probeLocalClassifier,
	readProbeAnswers,
	summarizeProbe,
	PROBE_CHOICE_CRITERIA,
	PROBE_SHAPES,
	PROBE_TIMEOUT_MS,
} from "./core/classifier-probe.ts";
export type { ProbeAnswers, ProbeResult } from "./core/classifier-probe.ts";
export type { DialogueContext, DialogueUi } from "./dialogue-ui.ts";
export { loadSimulate, getScenario, simulateRetry, SimulateError } from "./core/simulate.ts";
export type { SimulateConfig, SimulateResult } from "./core/simulate.ts";
export { resolveFallbacks, effectiveIds, pickNextEffective } from "./core/availability.ts";
export type { AvailabilityPort } from "./core/ports.ts";
export type {
	Availability,
	BlockedMap,
	ClassifiedError,
	ErrorClass,
	ErrorScope,
	IdleResetConfig,
	ModelId,
	ResolvedEntry,
	ResolvedFallbacks,
	RouteReason,
	SwitchbackState,
} from "./core/types.ts";
