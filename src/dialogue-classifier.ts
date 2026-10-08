/**
 * The decision-model half of the `/switchback-config` dialogue: choosing a
 * classifier for a virtual model, and the wizard that creates, edits, renames,
 * tests and deletes reusable `decisionModels` entries.
 *
 * Split out of `src/dialogue.ts` because it is the larger half and grew
 * independently: it is the only part that needs the provider catalog, the live
 * endpoint model discovery and the probe. The shell imports the two entry
 * points it needs (`decisionModelPicker`, `decisionModelsMenu`); everything
 * else here is private to this module, and the shared prompts and session
 * primitives come from `src/dialogue-ui.ts`.
 *
 * Secrets stay unrepresentable in the file: the editor only ever receives a
 * derived secret NAME, and the value goes straight to the encrypted store.
 *
 * See `src/dialogue.ts` for the design of the dialogue as a whole.
 */

import {
	addDecisionModel,
	countDecisionModelReferences,
	removeDecisionModel,
	renameDecisionModel,
	setDecisionModel,
	updateDecisionModel,
	type DecisionModelInput,
	type DecisionModelPatch,
} from "./config-editor.ts";
import { LOCAL_CLASSIFIER_APIS } from "./config.ts";
import {
	classifierBaseUrlNote,
	defaultDecisionModelName,
	directEndpointWouldClobber,
	type ClassifierProviderOption,
} from "./classifier-catalog.ts";
import { discoverOllamaModels } from "./classifier-discovery.ts";
import { formatProbeReport } from "./classifier-probe.ts";
import {
	describeJev,
	errorMessage,
	findModel,
	promptNameLast,
	promptOptional,
	promptRequired,
	readConfigOrReport,
	saveOrRevert,
	screenTitle,
	secretNameFor,
	tryReadConfig,
	type DialogueContext,
	type DialogueSession,
} from "./dialogue-ui.ts";
import type { DecisionModelEntry, JevConfig } from "./types.ts";

export async function decisionModelPicker(
	ctx: DialogueContext,
	session: DialogueSession,
	virtualId: string,
): Promise<void> {
	const noneOption = "(none - report and cycle)";
	const inlineOption = "(inline - configure directly)...";
	const newOption = "New decision model...";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const model = findModel(config, virtualId);
		if (model === undefined) return;
		const dmLabels = (config.decisionModels ?? []).map((d) => `${d.name} - ${d.provider}/${d.id}`);
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, `decision model for ${virtualId}\ncurrently: ${describeJev(model.jev)}`),
			[noneOption, ...dmLabels, inlineOption, newOption, backOption],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === noneOption) {
			setDecisionModel(session.loaded, virtualId, null);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: classifier cleared (reports and cycles)`, "info");
				return;
			}
			continue;
		}
		if (choice === inlineOption) {
			const existing = model.jev !== undefined && !("decisionModel" in model.jev) ? model.jev : undefined;
			const inline = await collectJevFields(ctx, session, existing, virtualId);
			if (inline === undefined) continue;
			setDecisionModel(session.loaded, virtualId, inline);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: inline classifier set`, "info");
				await offerClassifierTest(ctx, session, jevFromInput(inline));
				return;
			}
			continue;
		}
		if (choice === newOption) {
			const created = await decisionModelWizard(ctx, session);
			if (created === undefined) continue;
			setDecisionModel(session.loaded, virtualId, { decisionModel: created.name });
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: decision model "${created.name}" created and set`, "info");
				return;
			}
			continue;
		}
		const name =
			dmLabels.indexOf(choice) >= 0 ? (config.decisionModels ?? [])[dmLabels.indexOf(choice)]?.name : undefined;
		const entry = name !== undefined ? (config.decisionModels ?? []).find((d) => d.name === name) : undefined;
		if (entry === undefined) continue;
		setDecisionModel(session.loaded, virtualId, { decisionModel: entry.name });
		if (await saveOrRevert(ctx, session)) {
			ctx.ui.notify(`${virtualId}: decision model "${entry.name}" set`, "info");
			return;
		}
	}
}

export async function decisionModelsMenu(ctx: DialogueContext, session: DialogueSession): Promise<void> {
	const addOption = "Add decision model...";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const entries = config.decisionModels ?? [];
		const labels = entries.map((d) => `${d.name} - ${d.provider}/${d.id}`);
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, "decision models (reusable classifier configs)"),
			[...labels, addOption, backOption],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === addOption) {
			await decisionModelWizard(ctx, session);
			continue;
		}
		const name = labels.indexOf(choice) >= 0 ? entries[labels.indexOf(choice)]?.name : undefined;
		const entry = name !== undefined ? entries.find((d) => d.name === name) : undefined;
		if (entry !== undefined) await decisionModelEntryMenu(ctx, session, entry);
	}
}

async function decisionModelEntryMenu(
	ctx: DialogueContext,
	session: DialogueSession,
	entry: DecisionModelEntry,
): Promise<void> {
	const renameOption = "Rename (updates references)";
	const editOption = "Edit fields";
	const testOption = "Test classifier (choice, score, noul)";
	const deleteOption = "Delete";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const current = (config.decisionModels ?? []).find((d) => d.name === entry.name);
		if (current === undefined) return; // deleted elsewhere in this session
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, `${current.name} - ${current.provider}/${current.id}`),
			[
				renameOption,
				editOption,
				...(ctx.probeClassifier !== undefined ? [testOption] : []),
				deleteOption,
				backOption,
			],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === testOption) {
			await runClassifierTest(ctx, session, {
				provider: current.provider,
				id: current.id,
				...(current.baseUrl !== undefined ? { baseUrl: current.baseUrl } : {}),
				...(current.api !== undefined ? { api: current.api } : {}),
				...(current.apiKey !== undefined ? { apiKey: current.apiKey } : {}),
			});
			continue;
		}
		if (choice === renameOption) {
			const newName = await promptRequired(
				ctx,
				screenTitle(session.loaded, `rename decision model "${current.name}"`),
				current.name,
			);
			if (newName === undefined || newName === current.name) continue;
			renameDecisionModel(session.loaded, current.name, newName);
			if (await saveOrRevert(ctx, session)) {
				entry.name = newName;
				ctx.ui.notify(`renamed to "${newName}"; references updated`, "info");
			}
			continue;
		}
		if (choice === editOption) {
			const patch = await collectJevPatch(ctx, session, current);
			if (patch === undefined) continue;
			updateDecisionModel(session.loaded, current.name, patch);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`decision model "${current.name}" updated`, "info");
			}
			continue;
		}
		if (choice === deleteOption) {
			const refs = countDecisionModelReferences(session.loaded, current.name);
			if (refs > 0) {
				ctx.ui.notify(
					`"${current.name}" is still referenced by ${refs} model(s) - set their decision model first`,
					"warning",
				);
				continue;
			}
			const confirmed = await ctx.ui.confirm(
				screenTitle(session.loaded, `delete decision model "${current.name}"`),
				`Delete "${current.name}" (${current.provider}/${current.id}) from ${session.loaded.path}?`,
			);
			if (!confirmed) continue;
			removeDecisionModel(session.loaded, current.name);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`deleted "${current.name}"`, "info");
				return;
			}
		}
	}
}

/** Collect a brand-new decision model entry. The order is provider → baseUrl →
 * model id → apiKey → name (last, prefilled). The user can Tab + Enter through
 * the whole flow when accepting the defaults; the only prompt that requires a
 * real decision is the apiKey action (new secret, keep existing, or none).
 */
async function decisionModelWizard(
	ctx: DialogueContext,
	session: DialogueSession,
): Promise<DecisionModelInput | undefined> {
	// Tolerant read: on a fresh layer there is no config yet and no name to clash with;
	// addDecisionModel + the save gate still own the uniqueness rule.
	const config = tryReadConfig(session.loaded);
	const knownNames = (config?.decisionModels ?? []).map((d) => d.name);

	// 1. Provider
	const option = await chooseClassifierProvider(ctx, session, undefined);
	if (option === undefined) return undefined;

	// 2. baseUrl (always prefilled for both catalog and local; "-" clears it)
	const baseUrl = await chooseBaseUrl(ctx, session, option, undefined);
	if (baseUrl === undefined) return undefined;

	// 3. Model id (from the provider's catalog classifiers, or asked of the endpoint itself)
	const id = await chooseClassifierModel(ctx, session, option, undefined, baseUrl ?? option.baseUrl);
	if (id === undefined) return undefined;

	// apiKey / api / baseUrl are loader-coupled: apiKey and api both require a
	// baseUrl, so a cleared baseUrl means none of those fields apply. Skip the
	// apiKey step entirely when the user typed "-".
	let apiKeyResult: ApiKeyAction = { kind: "none" };
	if (baseUrl !== null) {
		// 4. apiKey action: collect the user's choice (none / pick existing / new
		//    secret value) but defer the secret-store write until we know the
		//    final decision-model name - the store entry is derived from the
		//    name so a single secret can be re-keyed under the new name.
		apiKeyResult = await apiKeyAction(ctx, session, undefined, option.provider);
		if (apiKeyResult.kind === "cancel") return undefined;
	}

	// 5. Name (LAST, prefilled). Only the catalog providers need an apiKey at
	//    all - a local Ollama / llama-server ignores it; a local server also
	//    needs one as a non-empty transport requirement, but the wizard sets
	//    it for them when the user picks "no api key" or skips the step.
	const rest: Partial<DecisionModelInput> = {};
	if (baseUrl !== null && baseUrl !== undefined) rest.baseUrl = baseUrl;
	if (baseUrl !== null && baseUrl !== undefined) {
		const api = option.api ?? LOCAL_CLASSIFIER_APIS[0];
		if (api !== undefined) rest.api = api;
	}
	if (apiKeyResult.kind === "secret") {
		// Defer the secret-store commit until the name is known so the store
		// entry follows the decision-model name (`secret:<name>-key`); we pass
		// apiKeyResult.value into the new logic further below.
	}
	// For local endpoints the transport defaults to a non-empty bearer token
	// (`local-classifier.ts` falls back to the provider id), so an apiKey in
	// the config is optional. For catalog providers the user must either
	// supply a secret or accept "no api key" - the wizard does not write a
	// literal token to disk in either path.

	const suggestedName = defaultDecisionModelName(option.provider, id);
	const name = await promptNameLast(ctx, session.loaded, suggestedName, knownNames);
	if (name === undefined) return undefined;

	// Commit the apiKey value (if any) under the now-known name, then build the
	// DecisionModelInput. Deferring the write keeps the secret name aligned with
	// the decision-model name regardless of whether the user kept the suggested
	// default or typed their own.
	let finalRest: Partial<DecisionModelInput> = rest;
	if (apiKeyResult.kind === "secret") {
		const secretName = secretNameFor(name);
		try {
			session.secrets.set(secretName, apiKeyResult.value);
		} catch (error) {
			ctx.ui.notify(`secret store refused the value: ${errorMessage(error)}`, "error");
			return undefined;
		}
		finalRest = { ...rest, apiKeySecretName: secretName };
	}

	const input: DecisionModelInput = { name, provider: option.provider, id, ...finalRest };
	try {
		addDecisionModel(session.loaded, input);
	} catch (error) {
		ctx.ui.notify(errorMessage(error), "warning");
		return undefined;
	}
	if (await saveOrRevert(ctx, session)) {
		ctx.ui.notify(`decision model "${name}" added`, "info");
		await offerClassifierTest(ctx, session, jevFromInput({ provider: option.provider, id, rest: finalRest }));
		return input;
	}
	return undefined;
}

/** The inline classifier config a wizard result describes (used for the capability test). */
function jevFromInput(fields: { provider: string; id: string; rest?: Partial<DecisionModelInput> }): JevConfig {
	const rest = fields.rest ?? {};
	return {
		provider: fields.provider,
		id: fields.id,
		...(rest.baseUrl !== undefined ? { baseUrl: rest.baseUrl } : {}),
		...(rest.api !== undefined ? { api: rest.api } : {}),
		...(rest.apiKeySecretName !== undefined ? { apiKey: `secret:${rest.apiKeySecretName}` } : {}),
	};
}

/**
 * Choose the classifier provider.
 *
 * The picker shows two sections, separated by header lines that explain what
 * each side means:
 *
 *   - Catalog providers (resolved through pi) - TypeSafe, OpenRouter, ...
 *     These speak `typesafe-system-one` over HTTPS; the wizard sets the
 *     provider's default baseUrl automatically.
 *   - Local SystemOne endpoints (you run the server) - Ollama, llama.cpp.
 *     The wizard sets the `/v1/systemone` baseUrl from OLLAMA_HOST /
 *     LLAMA_SERVER_URL or a well-known default; switchback registers the
 *     classifier itself.
 *
 * "Other (type a provider id)..." is the escape hatch for a custom provider
 * not in either section. The provider already in use, if any, is offered first
 * so Enter keeps it.
 *
 * Falls back to a text prompt when no catalog was supplied (non-TUI contexts,
 * tests).
 */
async function chooseClassifierProvider(
	ctx: DialogueContext,
	session: DialogueSession,
	current: string | undefined,
): Promise<ClassifierProviderOption | undefined> {
	const options = ctx.classifierProviders ?? [];
	if (options.length === 0) {
		const provider = await promptRequired(ctx, screenTitle(session.loaded, "classifier provider"), current ?? "");
		if (provider === undefined) return undefined;
		return declaredEndpoint(provider);
	}
	// The provider already in use is offered first so Enter keeps it.
	const ordered = [...options].sort((a, b) => (a.provider === current ? -1 : b.provider === current ? 1 : 0));
	const otherOption = "Other (type a provider id)...";
	const backOption = "Back";
	const choice = await ctx.ui.select(
		screenTitle(session.loaded, `classifier provider${current === undefined ? "" : ` (current: ${current})`}`),
		[...ordered.map((option) => option.label), otherOption, backOption],
	);
	if (choice === undefined || choice === backOption) return undefined;
	if (choice === otherOption) {
		const provider = await promptRequired(
			ctx,
			screenTitle(session.loaded, "classifier provider id"),
			current ?? "",
		);
		if (provider === undefined) return undefined;
		return declaredEndpoint(provider);
	}
	const index = ordered.findIndex((o) => o.label === choice);
	return index >= 0 ? ordered[index] : undefined;
}

/**
 * An endpoint the user names themselves: pi has no catalog entry for it, so
 * switchback registers the classifier from the config (`baseUrl` present). No
 * base URL or wire API is invented here - the wizard asks for both.
 */
function declaredEndpoint(provider: string): ClassifierProviderOption {
	return { provider, label: provider, displayName: provider, models: [], local: true, chatModels: 0 };
}

/** Choose the classifier model id from the provider's known classifiers, or type one.
 *
 * The picker offers what pi's catalog knows for this provider. When the catalog
 * knows nothing and the endpoint is reachable, the wizard asks the server
 * itself (Ollama's `/api/tags`, filtered by the `decision` capability) so a
 * freshly pointed endpoint does not have to wait for a routing failure to reveal
 * a wrong model id. Provider-agnostic on purpose: the trigger is "the catalog
 * cannot help here", not a hardcoded provider name.
 */
async function chooseClassifierModel(
	ctx: DialogueContext,
	session: DialogueSession,
	option: ClassifierProviderOption,
	current: string | undefined,
	baseUrl: string | undefined,
): Promise<string | undefined> {
	const prompt = (): Promise<string | undefined> =>
		promptRequired(ctx, screenTitle(session.loaded, `classifier model id for ${option.provider}`), current ?? "");

	let liveModels: readonly string[] = option.models;
	if (liveModels.length === 0 && baseUrl !== undefined) {
		const { models, error } = await discoverOllamaModels({ baseUrl });
		if (error !== undefined) {
			ctx.ui.notify(`no model list from ${baseUrl} (${error}); type the model id`, "warning");
		}
		const decisionOnly = models.filter((m) => m.decisionCapable).map((m) => m.id);
		if (decisionOnly.length > 0) liveModels = decisionOnly;
	}

	if (liveModels.length === 0) return prompt();
	const otherOption = "Other (type a model id)...";
	const backOption = "Back";
	const choice = await ctx.ui.select(screenTitle(session.loaded, `classifier model for ${option.provider}`), [
		...liveModels,
		otherOption,
		backOption,
	]);
	if (choice === undefined || choice === backOption) return undefined;
	if (choice === otherOption) return prompt();
	return choice;
}

/**
 * The base URL for the chosen endpoint.
 *
 * Two shapes, because the config means different things by the field:
 *
 *  - An endpoint the user declared (pi has no catalog entry): the base URL is
 *    required, since switchback registers the classifier from it.
 *  - A provider from pi's catalog: pi already resolves the endpoint, so the
 *    config normally carries **no** `baseUrl` at all and `Enter` keeps that.
 *    Typing one is an explicit override - and when pi owns chat models under
 *    that provider id, writing a direct endpoint would make pi replace them
 *    (its `applyExtension`), so the wizard refuses and says so.
 *
 * `"-"` always means "no direct endpoint".
 */
async function chooseBaseUrl(
	ctx: DialogueContext,
	session: DialogueSession,
	option: ClassifierProviderOption,
	current: string | undefined,
): Promise<string | null | undefined> {
	if (option.local) {
		const value = await promptOptional(
			ctx,
			screenTitle(
				session.loaded,
				`baseUrl for ${option.provider} — the SystemOne endpoint, e.g. http://host:port/v1 (required)`,
			),
			current,
		);
		if (value === undefined || value === null) return undefined;
		const trimmed = value.trim();
		// Required: an empty answer for a declared endpoint leaves nothing to register.
		return trimmed.length === 0 ? undefined : trimmed;
	}
	const note = classifierBaseUrlNote(option);
	const value = await ctx.ui.input(
		screenTitle(
			session.loaded,
			`baseUrl for ${option.provider} — Enter keeps pi's catalog (${note}), "-" clears, any URL overrides`,
		),
		current ?? "",
	);
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (trimmed === "-" || trimmed.length === 0) return null;
	if (directEndpointWouldClobber(option)) {
		ctx.ui.notify(
			`pi already serves ${option.chatModels} chat model(s) under "${option.provider}". ` +
				"A direct endpoint here would replace them with the classifier alone - " +
				`pick a distinct provider id ("${option.provider}-<suffix>") instead.`,
			"warning",
		);
		return undefined;
	}
	return trimmed;
}

/**
 * Send the capability prompt and report the verdict. See `src/classifier-probe.ts`.
 */
async function runClassifierTest(ctx: DialogueContext, session: DialogueSession, jev: JevConfig): Promise<void> {
	if (ctx.probeClassifier === undefined) return;
	const label = `${jev.provider}/${jev.id}${jev.baseUrl !== undefined ? ` at ${jev.baseUrl}` : ""}`;
	const result = await ctx.probeClassifier(resolveSecretRef(jev, session));
	ctx.ui.notify(formatProbeReport({ label, result }), result.ok ? "info" : "warning");
}

/**
 * Offer the one-shot capability test after a classifier config was written.
 *
 * Most SystemOne endpoints publish no model list, so the model id is guessed;
 * this is where a wrong guess (or a model without the `decision` capability)
 * surfaces, instead of at the first real routing failure.
 */
async function offerClassifierTest(ctx: DialogueContext, session: DialogueSession, jev: JevConfig): Promise<void> {
	if (ctx.probeClassifier === undefined) return;
	const confirmed = await ctx.ui.confirm(
		screenTitle(session.loaded, `test ${jev.provider}/${jev.id} now?`),
		"Sends one SystemOne prompt that exercises choice, score and noul, so a wrong model id or endpoint shows up immediately.",
	);
	if (!confirmed) return;
	await runClassifierTest(ctx, session, jev);
}

/** Classifier fields for a NEW inline config / decision model. Undefined = user backed out. */
async function collectJevFields(
	ctx: DialogueContext,
	session: DialogueSession,
	existing: JevConfig | undefined,
	hint?: string,
): Promise<{ provider: string; id: string; rest?: Partial<DecisionModelInput> } | undefined> {
	const option = await chooseClassifierProvider(ctx, session, existing?.provider);
	if (option === undefined) return undefined;
	const baseUrl = await chooseBaseUrl(ctx, session, option, existing?.baseUrl);
	if (baseUrl === undefined) return undefined;
	const id = await chooseClassifierModel(ctx, session, option, existing?.id, baseUrl ?? option.baseUrl);
	if (id === undefined) return undefined;
	if (baseUrl === null) return { provider: option.provider, id };
	// `api` is aligned with the endpoint instead of asked: a direct endpoint speaks
	// exactly one wire API (switchback's own SystemOne transport), so the old
	// "(none)" choice offered an option that does not exist.
	const api = option.api ?? LOCAL_CLASSIFIER_APIS[0];
	const rest: Partial<DecisionModelInput> = { baseUrl, ...(api !== undefined ? { api } : {}) };
	const key = await apiKeyAction(ctx, session, existing?.apiKey, hint ?? option.provider);
	if (key.kind === "cancel") return undefined;
	if (key.kind === "secret") {
		const committedName = commitSecret(ctx, session, hint ?? option.provider, key.value);
		if (committedName === undefined) return undefined;
		rest.apiKeySecretName = committedName;
	}
	return { provider: option.provider, id, rest };
}

/**
 * Commit a secret value to the store under a name derived from `hint`. Returns
 * the chosen name on success, undefined on failure (the wizard treats undefined
 * as user cancellation). The hint should be the decision-model name when one
 * exists, or the provider id for inline jev.
 */
function commitSecret(ctx: DialogueContext, session: DialogueSession, hint: string, value: string): string | undefined {
	const name = secretNameFor(hint);
	try {
		session.secrets.set(name, value);
		return name;
	} catch (error) {
		ctx.ui.notify(`secret store refused the value: ${errorMessage(error)}`, "error");
		return undefined;
	}
}

/** Patch fields for an EXISTING decision model. Undefined = user backed out. */
async function collectJevPatch(
	ctx: DialogueContext,
	session: DialogueSession,
	current: DecisionModelEntry,
): Promise<DecisionModelPatch | undefined> {
	const option = await chooseClassifierProvider(ctx, session, current.provider);
	if (option === undefined) return undefined;
	const patch: DecisionModelPatch = {};
	if (option.provider !== current.provider) patch.provider = option.provider;
	const baseUrl = await chooseBaseUrl(ctx, session, option, current.baseUrl);
	if (baseUrl === undefined) return undefined;
	const id = await chooseClassifierModel(ctx, session, option, current.id, baseUrl ?? option.baseUrl);
	if (id === undefined) return undefined;
	if (id !== current.id) patch.id = id;
	if (baseUrl === null) {
		// updateDecisionModel clears api/apiKey with baseUrl (loader rule: they require it).
		patch.baseUrl = null;
		return patch;
	}
	patch.baseUrl = baseUrl;
	// Keep the entry's own api, or set the endpoint's for a newly added one.
	if (current.api === undefined) {
		const api = option.api ?? LOCAL_CLASSIFIER_APIS[0];
		if (api !== undefined) patch.api = api;
	}
	const key = await apiKeyAction(ctx, session, current.apiKey, current.name);
	if (key.kind === "cancel") return undefined;
	if (key.kind === "none") patch.apiKeySecretName = null;
	else if (key.kind === "secret") {
		const committedName = commitSecret(ctx, session, current.name, key.value);
		if (committedName === undefined) return undefined;
		patch.apiKeySecretName = committedName;
	}
	return patch;
}
/** Resolve a `secret:<name>` reference for use (the probe needs the real token). */
function resolveSecretRef(jev: JevConfig, session: DialogueSession): JevConfig {
	const apiKey = jev.apiKey;
	if (apiKey === undefined || !apiKey.startsWith("secret:")) return jev;
	const stored = session.secrets.get(apiKey.slice("secret:".length));
	return stored === undefined ? jev : { ...jev, apiKey: stored };
}

/**
 * What the user decided about the API key.
 *
 * `keep` leaves the field untouched (an existing key stays), `none` means "no
 * key" (a new entry gets none, an existing one loses it), `secret` names the
 * store entry to reference, and `cancel` abandons the whole step. Collapsing
 * these into one nullable string made "no key" indistinguishable from "back
 * out", which turned a valid choice into an aborted wizard.
 */
type ApiKeyAction =
	| { kind: "keep" }
	| { kind: "none" }
	/** Value picked up; the wizard commits it under a name it derives later. */
	| { kind: "secret"; value: string }
	| { kind: "cancel" };

/**
 * Ask what to do about the API key.
 *
 * The value is the only thing asked for: the store name is derived
 * (`secretNameFor`) because it is an internal detail the user has no reason to
 * invent.
 */
async function apiKeyAction(
	ctx: DialogueContext,
	session: DialogueSession,
	current: string | undefined,
	hint: string,
): Promise<ApiKeyAction> {
	const hasCurrent = current !== undefined;
	const keepOption = hasCurrent
		? `Keep current (${current.startsWith("secret:") ? current : "value set by hand"})`
		: "(no API key)";
	const existingOption = "Use existing secret...";
	const newOption = "New secret...";
	const removeOption = "Remove API key";
	const choice = await ctx.ui.select(
		screenTitle(session.loaded, "API key - stored encrypted; the config only carries secret:<name>"),
		hasCurrent ? [keepOption, existingOption, newOption, removeOption] : [keepOption, existingOption, newOption],
	);
	if (choice === undefined) return { kind: "cancel" };
	if (choice === keepOption) return hasCurrent ? { kind: "keep" } : { kind: "none" };
	if (choice === removeOption) return { kind: "none" };
	if (choice === existingOption) {
		const names = session.secrets.list();
		if (names.length === 0) {
			ctx.ui.notify("no secrets stored yet - pick 'New secret...'", "warning");
			return { kind: "cancel" };
		}
		const name = await ctx.ui.select(screenTitle(session.loaded, "reference which stored secret?"), [...names]);
		return name === undefined ? { kind: "cancel" } : { kind: "secret", value: name };
	}
	if (choice !== newOption) return { kind: "cancel" }; // an option this flow does not know: back out
	const value = await promptRequired(
		ctx,
		screenTitle(
			session.loaded,
			`API key for ${hint} - the store name is derived from the decision model, not shown again`,
		),
		"secret value",
	);
	if (value === undefined) return { kind: "cancel" };
	return { kind: "secret", value };
}
