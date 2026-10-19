/**
 * The decision-model half of the `/switchback-config` dialogue: naming the
 * decision model a virtual model uses, and the wizard that creates, edits,
 * renames, tests and deletes `decisionModels` entries.
 *
 * A decision model is addressed as `provider/model-id` - the same shape as a
 * fallback. The address alone is enough when the host can resolve it from its
 * classifier catalog; a `decisionModels` entry at the same address adds the
 * connection details (`baseUrl`, `apiKey`) that make a direct SystemOne endpoint
 * reachable from any host.
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
} from "switchback-core/config-editor.ts";
import {
	classifierBaseUrlNote,
	directEndpointWouldClobber,
	type ClassifierProviderOption,
} from "switchback-core/classifier-catalog.ts";
import { discoverOllamaModels } from "switchback-core/classifier-discovery.ts";
import { formatProbeReport } from "switchback-core/classifier-probe.ts";
import {
	describeDecisionModel,
	errorMessage,
	findModel,
	promptAddressLast,
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
import type { DecisionModelConfig, DecisionModelEntry } from "switchback-core/types.ts";

export async function decisionModelPicker(
	ctx: DialogueContext,
	session: DialogueSession,
	virtualId: string,
): Promise<void> {
	const noneOption = "(none - report and cycle)";
	const newOption = "New decision model...";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const model = findModel(config, virtualId);
		if (model === undefined) return;
		const entries = Object.entries(config.decisionModels ?? {});
		const labels = entries.map(([address, entry]) => describeEntry(address, entry));
		const choice = await ctx.ui.select(
			screenTitle(
				session.loaded,
				`decision model for ${virtualId}\ncurrently: ${describeDecisionModel(model.decisionModel)}`,
			),
			[noneOption, ...labels, newOption, backOption],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === noneOption) {
			setDecisionModel(session.loaded, virtualId, null);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: decision model cleared (reports and cycles)`, "info");
				return;
			}
			continue;
		}
		if (choice === newOption) {
			const created = await decisionModelWizard(ctx, session);
			if (created === undefined) continue;
			setDecisionModel(session.loaded, virtualId, created.address);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`${virtualId}: decision model ${created.address} created and set`, "info");
				await offerClassifierTest(ctx, session, entryForInput(created), created.address);
				return;
			}
			continue;
		}
		const index = labels.indexOf(choice);
		const picked = index >= 0 ? entries[index] : undefined;
		if (picked === undefined) continue;
		setDecisionModel(session.loaded, virtualId, picked[0]);
		if (await saveOrRevert(ctx, session)) {
			ctx.ui.notify(`${virtualId}: decision model ${picked[0]} set`, "info");
			await offerClassifierTest(ctx, session, picked[1], picked[0]);
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
		const entries = Object.entries(config.decisionModels ?? {});
		const labels = entries.map(([address, entry]) => describeEntry(address, entry));
		const choice = await ctx.ui.select(
			screenTitle(session.loaded, "decision models (address-keyed classifier connection details)"),
			[...labels, addOption, backOption],
		);
		if (choice === undefined || choice === backOption) return;
		if (choice === addOption) {
			await decisionModelWizard(ctx, session);
			continue;
		}
		const index = labels.indexOf(choice);
		const picked = index >= 0 ? entries[index] : undefined;
		if (picked !== undefined) await decisionModelEntryMenu(ctx, session, picked[0]);
	}
}

async function decisionModelEntryMenu(ctx: DialogueContext, session: DialogueSession, address: string): Promise<void> {
	const renameOption = "Rename address (updates references)";
	const editOption = "Edit connection (baseUrl, apiKey)";
	const testOption = "Test classifier (choice, score, noul)";
	const deleteOption = "Delete";
	const backOption = "Back";
	for (;;) {
		const config = readConfigOrReport(ctx, session.loaded);
		if (config === undefined) return;
		const current = (config.decisionModels ?? {})[address];
		if (current === undefined) return; // deleted elsewhere in this session
		const choice = await ctx.ui.select(screenTitle(session.loaded, describeEntry(address, current)), [
			renameOption,
			editOption,
			...(ctx.probeClassifier !== undefined ? [testOption] : []),
			deleteOption,
			backOption,
		]);
		if (choice === undefined || choice === backOption) return;
		if (choice === testOption) {
			await runClassifierTest(ctx, session, current, address);
			continue;
		}
		if (choice === renameOption) {
			const newAddress = await promptRequired(
				ctx,
				screenTitle(session.loaded, `rename decision model ${address} (provider/model-id)`),
				address,
			);
			if (newAddress === undefined || newAddress === address) continue;
			if (!newAddress.includes("/")) {
				ctx.ui.notify(`an address is "provider/model-id" - "${newAddress}" has no provider`, "warning");
				continue;
			}
			if (Object.hasOwn(config.decisionModels ?? {}, newAddress)) {
				ctx.ui.notify(`a decision model at "${newAddress}" already exists`, "warning");
				continue;
			}
			renameDecisionModel(session.loaded, address, newAddress);
			if (await saveOrRevert(ctx, session)) {
				address = newAddress;
				ctx.ui.notify(`renamed to ${newAddress}; references updated`, "info");
			}
			continue;
		}
		if (choice === editOption) {
			const patch = await collectConnection(ctx, session, address, current);
			if (patch === undefined) continue;
			updateDecisionModel(session.loaded, address, patch);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`decision model ${address} updated`, "info");
			}
			continue;
		}
		if (choice === deleteOption) {
			const refs = countDecisionModelReferences(session.loaded, address);
			if (refs > 0) {
				ctx.ui.notify(
					`${address} is still named by ${refs} model(s) - set their decision model first`,
					"warning",
				);
				continue;
			}
			const confirmed = await ctx.ui.confirm(
				screenTitle(session.loaded, `delete decision model ${address}`),
				`Delete ${address} from ${session.loaded.path}? Chains that name it fall back to catalog resolution.`,
			);
			if (!confirmed) continue;
			removeDecisionModel(session.loaded, address);
			if (await saveOrRevert(ctx, session)) {
				ctx.ui.notify(`deleted ${address}`, "info");
				return;
			}
		}
	}
}

/**
 * Collect a brand-new decision model entry. The order is provider -> baseUrl ->
 * model id -> apiKey -> address (last, prefilled). The address is the map key,
 * so it is asked after the connection details it describes.
 */
async function decisionModelWizard(
	ctx: DialogueContext,
	session: DialogueSession,
): Promise<DecisionModelInput | undefined> {
	// Tolerant read: on a fresh layer there is no config yet and no address to clash with.
	const config = tryReadConfig(session.loaded);
	const knownAddresses = Object.keys(config?.decisionModels ?? {});

	// 1. Provider
	const option = await chooseClassifierProvider(ctx, session, undefined);
	if (option === undefined) return undefined;

	// 2. baseUrl ("-" keeps catalog resolution; a URL declares a direct endpoint)
	const baseUrl = await chooseBaseUrl(ctx, session, option, undefined);
	if (baseUrl === undefined) return undefined;

	// 3. Model id (from the provider's catalog classifiers, or asked of the endpoint itself)
	const id = await chooseClassifierModel(ctx, session, option, undefined, baseUrl ?? option.baseUrl);
	if (id === undefined) return undefined;

	// 4. apiKey: only a direct endpoint carries one (the loader requires it there).
	let pendingKey: ApiKeyAction = { kind: "local" };
	if (baseUrl !== null) {
		pendingKey = await apiKeyAction(ctx, session, undefined, `${option.provider}/${id}`);
		if (pendingKey.kind === "cancel") return undefined;
	}

	// 5. Address (LAST, prefilled). The secret-store entry is derived from the
	//    address, so it is committed only after the address is known.
	const address = await promptAddressLast(ctx, session.loaded, `${option.provider}/${id}`, knownAddresses);
	if (address === undefined) return undefined;

	let apiKeySecretName: string | undefined;
	if (pendingKey.kind === "new") {
		apiKeySecretName = commitSecret(ctx, session, address, pendingKey.value);
		if (apiKeySecretName === undefined) return undefined;
	} else if (pendingKey.kind === "existing") {
		apiKeySecretName = pendingKey.name;
	}

	const input: DecisionModelInput = {
		address,
		...(baseUrl !== null ? { baseUrl } : {}),
		...(apiKeySecretName !== undefined ? { apiKeySecretName } : {}),
	};
	try {
		addDecisionModel(session.loaded, input);
	} catch (error) {
		ctx.ui.notify(errorMessage(error), "warning");
		return undefined;
	}
	if (await saveOrRevert(ctx, session)) {
		ctx.ui.notify(`decision model ${address} added`, "info");
		await offerClassifierTest(ctx, session, entryForInput(input), address);
		return input;
	}
	return undefined;
}

/**
 * Edit an existing entry's connection details. The address (provider/model id)
 * is the map key and is changed through the rename action instead, so this only
 * collects `baseUrl` and `apiKey`.
 */
async function collectConnection(
	ctx: DialogueContext,
	session: DialogueSession,
	address: string,
	current: DecisionModelEntry,
): Promise<DecisionModelPatch | undefined> {
	const baseUrl = await promptOptional(
		ctx,
		screenTitle(session.loaded, `baseUrl for ${address} - a direct SystemOne endpoint ("-" clears it, Esc keeps)`),
		current.baseUrl,
	);
	if (baseUrl === undefined) return undefined;
	const patch: DecisionModelPatch = {};
	if (baseUrl === null) {
		// updateDecisionModel clears apiKey with baseUrl (the loader rule: it requires baseUrl).
		patch.baseUrl = null;
		return patch;
	}
	if (baseUrl !== current.baseUrl) patch.baseUrl = baseUrl;
	const key = await apiKeyAction(ctx, session, current.apiKey, address);
	if (key.kind === "cancel") return undefined;
	if (key.kind === "local") patch.apiKeySecretName = null;
	else if (key.kind === "existing") patch.apiKeySecretName = key.name;
	else if (key.kind === "new") {
		const committedName = commitSecret(ctx, session, address, key.value);
		if (committedName === undefined) return undefined;
		patch.apiKeySecretName = committedName;
	}
	return patch;
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
 * switchback registers the classifier from the config (`baseUrl` present).
 */
function declaredEndpoint(provider: string): ClassifierProviderOption {
	return { provider, label: provider, displayName: provider, models: [], local: true, chatModels: 0 };
}

/** Choose the classifier model id from the provider's known classifiers, or type one. */
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
 * Send the capability prompt and report the verdict. See `packages/core/src/classifier-probe.ts`.
 */
async function runClassifierTest(
	ctx: DialogueContext,
	session: DialogueSession,
	entry: DecisionModelEntry,
	address: string,
): Promise<void> {
	if (ctx.probeClassifier === undefined) return;
	const resolved = probeConfig(address, entry, session);
	if (resolved === undefined) {
		ctx.ui.notify(`${address}: the address has no "/" - cannot probe it`, "warning");
		return;
	}
	const label = `${resolved.provider}/${resolved.id}${
		resolved.baseUrl !== undefined ? ` at ${resolved.baseUrl}` : ""
	}`;
	const result = await ctx.probeClassifier(resolved);
	ctx.ui.notify(formatProbeReport({ label, result }), result.ok ? "info" : "warning");
}

/**
 * Offer the one-shot capability test after a decision model was written.
 *
 * Most SystemOne endpoints publish no model list, so the model id is guessed;
 * this is where a wrong guess (or a model without the `decision` capability)
 * surfaces, instead of at the first real routing failure.
 */
async function offerClassifierTest(
	ctx: DialogueContext,
	session: DialogueSession,
	entry: DecisionModelEntry,
	address: string,
): Promise<void> {
	if (ctx.probeClassifier === undefined) return;
	const confirmed = await ctx.ui.confirm(
		screenTitle(session.loaded, `test ${address} now?`),
		"Sends one SystemOne prompt that exercises choice, score and noul, so a wrong model id or endpoint shows up immediately.",
	);
	if (!confirmed) return;
	await runClassifierTest(ctx, session, entry, address);
}

function describeEntry(address: string, entry: DecisionModelEntry): string {
	return entry.baseUrl === undefined
		? `${address} - resolved from the classifier catalog`
		: `${address} - direct: ${entry.baseUrl}`;
}

function splitAddress(address: string): { provider: string; id: string } | undefined {
	const slash = address.indexOf("/");
	if (slash <= 0 || slash === address.length - 1) return undefined;
	return { provider: address.slice(0, slash), id: address.slice(slash + 1) };
}

/** The entry a wizard result describes, for the capability test. */
function entryForInput(input: DecisionModelInput): DecisionModelEntry {
	if (input.baseUrl === undefined) return {};
	return {
		baseUrl: input.baseUrl,
		apiKey: input.apiKeySecretName === undefined ? "local" : `secret:${input.apiKeySecretName}`,
	};
}

/** Resolve an entry into the probe's shape, pulling a `secret:` value from the store. */
function probeConfig(
	address: string,
	entry: DecisionModelEntry,
	session: DialogueSession,
): DecisionModelConfig | undefined {
	const parts = splitAddress(address);
	if (parts === undefined) return undefined;
	let apiKey = entry.apiKey;
	if (apiKey !== undefined && apiKey.startsWith("secret:")) {
		const stored = session.secrets.get(apiKey.slice("secret:".length));
		if (stored !== undefined) apiKey = stored;
	}
	return {
		provider: parts.provider,
		id: parts.id,
		...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
		...(apiKey !== undefined ? { apiKey } : {}),
	};
}

/**
 * Commit a secret value to the store under a name derived from the address.
 * Returns the chosen name on success, undefined on failure (the wizard treats
 * undefined as user cancellation).
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

/**
 * What the user decided about the API key.
 *
 * `keep` leaves the field untouched (an existing key stays), `local` means "no
 * secret - a local endpoint ignores the bearer token", `new` carries a value to
 * store under a derived name, `existing` names a stored secret to reference,
 * and `cancel` abandons the whole step.
 */
type ApiKeyAction =
	| { kind: "keep" }
	| { kind: "local" }
	| { kind: "new"; value: string }
	| { kind: "existing"; name: string }
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
	const hasCurrent = current !== undefined && current !== "local";
	const keepOption = hasCurrent
		? `Keep current (${current.startsWith("secret:") ? current : "value set by hand"})`
		: "(no API key - local endpoint)";
	const existingOption = "Use existing secret...";
	const newOption = "New secret...";
	const removeOption = "No secret (local endpoint)";
	const choice = await ctx.ui.select(
		screenTitle(session.loaded, "API key - stored encrypted; the config only carries secret:<name>"),
		hasCurrent ? [keepOption, existingOption, newOption, removeOption] : [keepOption, existingOption, newOption],
	);
	if (choice === undefined) return { kind: "cancel" };
	if (choice === keepOption) return hasCurrent ? { kind: "keep" } : { kind: "local" };
	if (choice === removeOption) return { kind: "local" };
	if (choice === existingOption) {
		const names = session.secrets.list();
		if (names.length === 0) {
			ctx.ui.notify("no secrets stored yet - pick 'New secret...'", "warning");
			return { kind: "cancel" };
		}
		const name = await ctx.ui.select(screenTitle(session.loaded, "reference which stored secret?"), [...names]);
		return name === undefined ? { kind: "cancel" } : { kind: "existing", name };
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
	return { kind: "new", value };
}
