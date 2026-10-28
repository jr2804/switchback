/**
 * The switchback provider package: OpenCode's entry point for the virtual
 * models this plugin publishes (`switchback/auto`, `switchback/auto-flash`, ...).
 *
 * The host resolves `providers.<id>.package = "opencode-switchback"`, imports
 * this module, and calls `model(modelID, settings)` once per request path. The
 * returned LanguageModel is a DELEGATING route: structurally a real builtin
 * route (an `openai-compatible` one, spread for its protocol/framing machinery
 * - a hand-rolled framing cannot be constructed, see the spike record), but
 * every execution step (`body.from`, `prepareTransport`, `streamPrepared`)
 * rebuilds against the PHYSICAL model the router picked for this attempt.
 *
 * The router itself lives behind the bridge (`src/bridge.ts`): this module has
 * no host context, so the plugin - which has the catalog, credentials and
 * switchback.yaml - answers "where does this attempt go" and re-answers after
 * every failure. The cascade in `streamPrepared` is pi's in-flight failover,
 * step for step: attempt → classify (plugin/decide) → block with the
 * classifier's reset window → advance to the next effective fallback, with one
 * hard limit: once a frame reached the client (`sawOutput`) the response is
 * committed and a failure propagates instead of restarting.
 *
 * Module identity: the imports of `@opencode/ai` and `effect` resolve to the
 * HOST's copies inside the install tree; the repo's own copies (dev deps) are
 * type- and test-time only.
 */

import { Effect, Stream } from "effect";
import type { PhysicalEntry, RouteAnswer } from "./bridge.ts";
import { readBridge } from "./bridge.ts";

/**
 * The structural slice of a host route this module touches. The host's own
 * `Route` type is not exported from `@opencode/ai`'s root barrel (deep subpath
 * only, and its generics are host-internal), so the delegation is typed
 * structurally against exactly what we call - the same call shapes the
 * end-to-end spike proved against the live host.
 */
interface RouteLike {
	readonly id: string;
	readonly protocol: string;
	readonly body: { readonly from: (request: unknown) => Promise<unknown> | Effect.Effect<unknown, unknown> };
	readonly prepareTransport: (body: unknown, request: unknown, options: unknown) => Effect.Effect<unknown, unknown>;
	readonly streamPrepared: (
		prepared: unknown,
		request: unknown,
		runtime: unknown,
		options: unknown,
	) => Stream.Stream<unknown, unknown>;
}

interface RouteRequestLike {
	readonly http?: { readonly headers?: Readonly<Record<string, string>> } | undefined;
	readonly promptCacheKey?: string | undefined;
	readonly messages?: readonly unknown[] | undefined;
}

/**
 * The base route the delegation spreads. `openai-compatible` needs a baseURL
 * to construct; the value is never dialed - every execution step is replaced
 * below, and `model()` never returns the base route's own transport. Loaded
 * lazily on first `model()` call: the host's `@opencode/ai` (2.1.3+) exposes
 * the `providers/*` subpaths, and an eager load would make merely importing
 * this module fail in environments whose dev copy predates them.
 */
/**
 * The two host classes this module instantiates, resolved at load time.
 *
 * Where they live depends on the host version: `@opencode/ai` 2.1.x re-exports
 * `LanguageModel` and `Message` from its root barrel, while 2.2.x dropped both
 * from the root and publishes them through the `./effect` entrypoint instead.
 * A static import therefore typechecks against exactly one of the two (and
 * fails at runtime against the other), so both specifiers are probed at load
 * time and the first module that actually exports `LanguageModel` wins.
 */
interface AiValues {
	readonly LanguageModel: new (input: { id: string; provider: string; route: unknown }) => unknown;
	readonly Message: { readonly effort?: (input: { effort: unknown }) => unknown } | undefined;
}

async function resolveAi(): Promise<AiValues> {
	const failures: string[] = [];
	for (const specifier of ["@opencode/ai", "@opencode/ai/effect"]) {
		try {
			const mod = (await import(/* @vite-ignore */ specifier)) as {
				LanguageModel?: unknown;
				Message?: unknown;
			};
			if (typeof mod.LanguageModel === "function") {
				return {
					LanguageModel: mod.LanguageModel as AiValues["LanguageModel"],
					Message: mod.Message as AiValues["Message"],
				};
			}
			failures.push(`${specifier}: no LanguageModel export`);
		} catch (error) {
			failures.push(`${specifier}: ${String((error as Error)?.message ?? error).split("\n")[0]}`);
		}
	}
	throw new Error(`switchback: cannot resolve LanguageModel (${failures.join("; ")})`);
}

// Top-level await is safe here: the host loads this package with `import()` and
// calls `model()` only after the module has settled.
const ai = await resolveAi();

let baseCache: RouteLike | undefined;

// Async prefetch: a bare `import()` honours the package's export map (import
// condition), which `createRequire` cannot - the installed @opencode/ai
// publishes `import`-only exports, so CJS require fails with "Cannot find
// module". The host's first `model()` call happens well after module load, so
// the promise has resolved by then; `base()` throws a clear error if not.
const baseReady = import(/* @vite-ignore */ "@opencode/ai/providers/openai-compatible").then(
	(mod) => {
		baseCache = (
			mod as unknown as {
				model: (modelID: string, settings: Record<string, unknown>) => { route: RouteLike };
			}
		).model("switchback-base", {
			// The placeholder key never dials: openai-compatible constructs its
			// bearer auth eagerly and would otherwise throw "Missing auth
			// credential: apiKey" at load time.
			baseURL: "http://switchback.invalid",
			apiKey: "switchback-placeholder",
		}).route as RouteLike;
	},
	(error) => {
		console.error("[switchback] base provider module failed to load:", error);
		throw error;
	},
);
void baseReady;

function base(): RouteLike {
	if (baseCache === undefined) {
		throw new Error("switchback: base provider module is still loading (host called model() too early)");
	}
	return baseCache;
}

/**
 * The provider-package seam. `modelID` is the configured chain id (`auto`,
 * `auto-flash`, ...); `settings` carries the variant overlay the host merged
 * (our variants publish `switchbackLevel`).
 */
export function model(
	modelID: string,
	settings: Readonly<Record<string, unknown>>,
): {
	id: string;
	provider: string;
	route: RouteLike;
} {
	const raw = typeof settings.chain === "string" && settings.chain.length > 0 ? settings.chain : modelID;
	// The catalog strips the provider prefix ("switchback/auto" -> "auto"), so a
	// selection without a variant overlay arrives prefix-less; config entries
	// always carry the full chain id.
	const chainId = raw.includes("/") ? raw : `switchback/${raw}`;
	const requestedLevel = typeof settings.switchbackLevel === "string" ? settings.switchbackLevel : undefined;

	const delegating: RouteLike = {
		...base(),
		id: "switchback-delegate",
		// Compile-time steps: the host runs `body.from` + `prepareTransport` on
		// THIS route before handing `prepared` to `streamPrepared`. Their output
		// is discarded - the cascade rebuilds both against the chosen target -
		// but they must succeed, so they stay on the base route's machinery.
		// (`...base` already carries them; listed here to document the contract.)
		body: base().body,
		prepareTransport: base().prepareTransport,
		// Execution: per-attempt dispatch through the bridge.
		streamPrepared: (prepared, request, runtime, options) =>
			cascade(chainId, requestedLevel, request as RouteRequestLike, runtime, options),
	};

	return new ai.LanguageModel({
		id: modelID,
		provider: "switchback",
		route: delegating,
	}) as unknown as { id: string; provider: string; route: RouteLike };
}

/**
 * The failover cascade for one request.
 *
 * Attempt order comes from the bridge (`reason: "user"` first - decide()'s
 * stickiness and idle reset make that the right entry reason for every new
 * dispatch - then `reason: "retry"` for each in-flight failure). A failure
 * before the first frame advances; a failure after it propagates.
 */
function cascade(
	chainId: string,
	requestedLevel: string | undefined,
	request: RouteRequestLike,
	runtime: unknown,
	options: unknown,
): Stream.Stream<unknown, unknown> {
	const sessionKey = readSessionKey(request);
	const bridge = readBridge();
	if (bridge === undefined) {
		return Stream.fail(
			new Error(
				"switchback: plugin not loaded - the switchback provider package needs the switchback plugin to route",
			),
		);
	}

	type Attempt = { readonly modelId: string; readonly entry: PhysicalEntry };

	const attemptStream = async (attempt: Attempt, level: string): Promise<Stream.Stream<unknown, unknown>> => {
		let route: RouteLike;
		let prepared: unknown;
		try {
			({ route, prepared } = await Effect.runPromise(preparedFor(attempt.entry, request, options, level)));
		} catch (error) {
			return failover(attempt.modelId, error);
		}
		let sawOutput = false;
		const inner: Stream.Stream<unknown, unknown> = Stream.map(
			route.streamPrepared(prepared, request, runtime, options),
			(frame) => {
				sawOutput = true;
				return frame;
			},
		);
		return Stream.catch(inner, (error): Stream.Stream<unknown, unknown> => {
			if (sawOutput) return Stream.fail(error);
			return Stream.unwrap(Effect.tryPromise(() => failover(attempt.modelId, error)));
		});
	};

	const failover = async (failedModelId: string, error: unknown): Promise<Stream.Stream<unknown, unknown>> => {
		const answer: RouteAnswer = await bridge.route({
			chainId,
			sessionKey,
			reason: "retry",
			...(requestedLevel !== undefined ? { level: normalizeLevel(requestedLevel) } : {}),
			failed: { modelId: failedModelId, message: errorMessage(error) },
		});
		if (answer.status !== "ok") {
			bridge.notify(sessionKey, `switchback: ${answer.message} - surfacing the failure`, "warning");
			return Stream.fail(error);
		}
		const entries = await bridge.entries(chainId);
		const entry = entries.find((e) => e.modelId === answer.current);
		if (entry === undefined) {
			bridge.notify(
				sessionKey,
				`switchback: routed to ${answer.current} but its connection is unavailable - surfacing the failure`,
				"warning",
			);
			return Stream.fail(error);
		}
		bridge.notify(
			sessionKey,
			`switchback: ${errorMessage(error).split("\n")[0]} - advancing to ${answer.current}`,
			"info",
		);
		return attemptStream({ modelId: answer.current, entry }, answer.level);
	};

	// The first decision is a plain route, not a retry: decide() then applies
	// stickiness / idle reset / pins exactly as pi's route() does.
	return Stream.unwrap(
		Effect.tryPromise(async (): Promise<Stream.Stream<unknown, unknown>> => {
			try {
				const answer = await bridge.route({
					chainId,
					sessionKey,
					reason: "user",
					...(requestedLevel !== undefined ? { level: normalizeLevel(requestedLevel) } : {}),
				});
				if (answer.status !== "ok") return Stream.fail(new Error(answer.message));
				const entries = await bridge.entries(chainId);
				const entry = entries.find((e) => e.modelId === answer.current);
				if (entry === undefined) {
					return Stream.fail(
						new Error(
							`switchback: routed to ${answer.current} but its connection is unavailable (${chainId})`,
						),
					);
				}
				return attemptStream({ modelId: answer.current, entry }, answer.level);
			} catch (error) {
				debugLog("first dispatch failed", error);
				throw error;
			}
		}),
	);
}

/** Build a physical route for one entry and run its compile steps against the live request. */
function preparedFor(
	entry: PhysicalEntry,
	request: RouteRequestLike,
	options: unknown,
	level: string,
): Effect.Effect<{ route: RouteLike; prepared: unknown }, unknown> {
	return Effect.tryPromise(async () => {
		try {
			const mod = (await loadProviderModule(entry.providerModule)) as unknown as {
				model?: (modelID: string, settings: Record<string, unknown>) => { route: RouteLike };
			};
			if (typeof mod.model !== "function") {
				throw new Error(
					`switchback: provider package ${entry.providerModule} does not export model(modelID, settings)`,
				);
			}
			const phys = mod.model(entry.modelID, { ...entry.settings });
			const local = localizeRequest(request, entry, level);
			const body = await toAwaitable(phys.route.body.from(local));
			const prepared = await toAwaitable(phys.route.prepareTransport(body, local, options));
			return { route: phys.route, prepared };
		} catch (error) {
			debugLog(`preparedFor(${entry.modelId}) failed`, error);
			throw error;
		}
	});
}

/**
 * Re-wrap the host request so the target provider module's own schema accepts
 * it. `LLMRequest.model` is `Schema.declare(v => v instanceof LanguageModel)`,
 * and the host bundles its own @opencode/ai copy - a host-built LanguageModel
 * fails our copy's instanceof check with an opaque "Schema validation failed".
 * Wrapping the same route in OUR LanguageModel keeps every value identical
 * while satisfying the realm check; everything else is structural.
 */
function localizeRequest(request: RouteRequestLike, entry: PhysicalEntry, level: string): RouteRequestLike {
	const model = (request as { model?: { id: unknown; provider: unknown; route: unknown } }).model;
	if (model === undefined || model.route === undefined) return request;
	// The wire request must carry the PHYSICAL model id/provider, not the virtual
	// chain id the host selected ("sb-free"): protocols build the upstream `model`
	// field from `request.model.id`, and the provider answers 400
	// "<chain-id> is not a valid model ID" when the virtual id leaks through.
	const [provider] = entry.modelId.split("/");
	const localModel = new ai.LanguageModel({
		id: entry.modelID as never,
		provider: (provider ?? model.provider) as never,
		route: model.route as never,
	});
	return {
		...(request as object),
		model: localModel,
		...(appliedLevel(request, level) !== undefined ? { messages: appliedLevel(request, level) } : {}),
	} as RouteRequestLike;
}

/**
 * The reasoning level the router settled on must reach the wire. The host only
 * emits `effort` content parts for variants it recognizes as its own effort
 * names (`session/runner/to-llm-message.ts` `variantEffort`), and our variants
 * are switchback's category scale, so the settled level is appended here as a
 * protocol-neutral `effort` part - exactly the shape every protocol reads.
 * `off` means "no reasoning": no part is appended, which is how a provider's
 * default (or its disabled-thinking path) is expressed.
 */
export function appliedLevel(request: RouteRequestLike, level: string): readonly unknown[] | undefined {
	if (level === "off") return request.messages;
	const messages = request.messages;
	if (messages === undefined) return undefined;
	const make = ai.Message?.effort;
	if (typeof make !== "function") return messages;
	return [...messages, make({ effort: level })];
}

/** Best-effort debug trace: stderr only, never throws - diagnostics must not break routing. */
export function debugLog(message: string, error?: unknown): void {
	try {
		console.error(
			`[switchback] ${message}${error === undefined ? "" : ` :: ${String((error as Error)?.stack ?? error)}`}`,
		);
	} catch {
		// Diagnostics must never break routing.
	}
}

/** Host route steps return Effect values at runtime; anything awaitable is accepted. */
async function toAwaitable(value: unknown): Promise<unknown> {
	if (
		value !== null &&
		typeof value === "object" &&
		"pipe" in value &&
		typeof (value as { pipe: unknown }).pipe === "function"
	) {
		return Effect.runPromise(value as Effect.Effect<unknown, unknown>);
	}
	return value;
}

/** Import a builtin provider module by specifier (already a live host builtin). */
function loadProviderModule(specifier: string): Promise<unknown> {
	return import(/* @vite-ignore */ specifier);
}

/** Stable per-conversation key for router state. */
function readSessionKey(request: RouteRequestLike): string {
	const header = request.http?.headers?.["x-opencode-session-id"];
	if (typeof header === "string" && header.length > 0) return header;
	const affinity = request.promptCacheKey;
	return typeof affinity === "string" && affinity.length > 0 ? affinity : "global";
}

/** Error text exactly as the classifier should see it: message first, body beneath. */ function errorMessage(
	error: unknown,
): string {
	if (error instanceof Error) {
		const body = (error as { responseBody?: unknown }).responseBody;
		const extra = typeof body === "string" && body.trim().length > 0 ? `\n${body}` : "";
		return `${error.message}${extra}`;
	}
	return String(error);
}

/** Variant ids are switchback's category names; anything else routes at `off`. */
function normalizeLevel(value: string): "off" | "minimal" | "medium" | "high" | "max" {
	return value === "minimal" || value === "medium" || value === "high" || value === "max" ? value : "off";
}
