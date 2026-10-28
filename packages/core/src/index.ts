/**
 * Public surface of `switchback-core`: the host-agnostic half of switchback.
 *
 * Everything here runs against the ports in `./ports.ts` - routing, dispatch,
 * error classification, reasoning levels, block/crash state, configuration, the
 * dialogue/config editor logic and the SystemOne transport. Nothing here reads a
 * host object directly, which is why both the pi extension
 * (`pi-switchback`) and the OpenCode plugin (`opencode-switchback`) can
 * share it. Host adapters import from this barrel; deep subpaths
 * (`switchback-core/state.ts`) also resolve, and the core's own modules use them.
 */

export { writeFileAtomic, AtomicWriteError } from "./atomic-write.ts";
export { decide, type RouteInputs } from "./routing.ts";
export { observeUnretriedFailure, assessFailure, recordDecideCrash, MAX_TRANSIENT_RETRIES } from "./failure.ts";
export { SYSTEM_ONE_API, systemOneClassifierPort } from "./systemone.ts";
export type { SystemOneClassifierPortOptions } from "./systemone.ts";
export type { Decision, DecisionOutcome } from "./decision.ts";
export { classifyError, PROMPT_VERSION, callClassifier, readChoice, CLASSIFIER_TIMEOUT_MS } from "./classify.ts";
export type { ClassificationResult, NoClassifierReason, ClassifierCallResult } from "./classify.ts";
export type { ClassifierPort, HostModel, ModelRegistryPort, NotifyPort, RouterRegistryPort } from "./ports.ts";
export {
	chooseThinkingLevel,
	availableCategories,
	supportedLevels,
	SWITCHBACK_THINKING_LEVELS,
	THINKING_PROMPT_VERSION,
} from "./thinking.ts";
export type { ThinkingLevelChoice, ThinkingLevelContext, ThinkingLevelSource } from "./thinking.ts";
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
} from "./idle.ts";
export type { IdleResetDecision, IdleResetInput } from "./idle.ts";
export {
	fitsContext,
	usableContextTokens,
	chooseContextCandidate,
	CONTEXT_FIT_RESERVE_TOKENS,
	CONTEXT_CANDIDATE_PROMPT_VERSION,
} from "./context-fit.ts";
export type { CandidateWindow, ContextCandidateChoice, ContextCandidateInput } from "./context-fit.ts";
export {
	blockModel,
	clearDisabled,
	disableModel,
	disabledFilePath,
	enableModel,
	getPinnedModel,
	isBlocked,
	isDisabled,
	pinFilePath,
	readBlockedMap,
	readDisabledMap,
	readPinMap,
	setPinnedModel,
	stateFilePath,
	unblockModel,
} from "./state.ts";
export type { PinMap } from "./state.ts";
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
export {
	loadConfig,
	findModelConfig,
	DEFAULT_CONFIG,
	SWITCHBACK_PROVIDER,
	SWITCHBACK_VIRTUAL_ID,
	ConfigError,
	piConfigDir,
	switchbackConfigDir,
	configFilePath,
	switchbackStateDir,
	resolveDecisionModel,
	resolveSecretApiKey,
	validateFileConfig,
} from "./config.ts";
export type { SwitchbackConfig, SwitchbackFileConfig, DecisionModelConfig, SecretResolver } from "./config.ts";
export type {
	DecisionModelEntry,
	DecisionModelId,
	ResolvedSwitchbackConfig,
	ResolvedSwitchbackFileConfig,
} from "./types.ts";
export {
	addDecisionModel,
	addFallback,
	addVirtualModel,
	countDecisionModelReferences,
	loadConfigFile,
	moveFallback,
	readConfigFile,
	removeDecisionModel,
	removeFallback,
	removeVirtualModel,
	renameDecisionModel,
	renameVirtualModel,
	saveConfigFile,
	setDecisionModel,
	setDebug,
	setFallbacks,
	setIdleReset,
	setVirtualModelName,
	updateDecisionModel,
} from "./config-editor.ts";
export type { DecisionModelInput, DecisionModelPatch, LoadedConfig } from "./config-editor.ts";
export {
	buildClassifierProviders,
	classifierBaseUrlNote,
	defaultDecisionModelName,
	directEndpointWouldClobber,
} from "./classifier-catalog.ts";
export type {
	ClassifierModelSummary,
	ClassifierProviderOption,
	ClassifierProviderSource,
} from "./classifier-catalog.ts";
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
} from "./classifier-probe.ts";
export type { ProbeAnswers, ProbeResult } from "./classifier-probe.ts";
export { loadSimulate, getScenario, simulateRetry, SimulateError } from "./simulate.ts";
export type { SimulateConfig, SimulateResult } from "./simulate.ts";
export { resolveFallbacks, effectiveIds, pickNextEffective } from "./availability.ts";
export type { AvailabilityPort } from "./ports.ts";
export type {
	Availability,
	BlockedMap,
	DisabledMap,
	ClassifiedError,
	ErrorClass,
	ErrorScope,
	IdleResetConfig,
	ModelId,
	ResolvedEntry,
	ResolvedFallbacks,
	RouteReason,
	SwitchbackState,
} from "./types.ts";
