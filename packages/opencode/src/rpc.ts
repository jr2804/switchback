/**
 * The `switchback` RPC: the channel that carries notices from the server
 * plugin to whatever client is attached (TUI today, GUI later).
 *
 * Why an RPC and not just a chat message: a synthetic session message is the
 * only notice channel a *server* plugin has, and it lands in the transcript -
 * a fallback that happened mid-turn reads like part of the conversation. A
 * client with a real toast surface should not have to accept that. The TUI
 * attaches (calling `attach`), receives every notice as an event, and shows it
 * as a toast; when nothing is attached the server plugin keeps using the
 * synthetic message so headless `opencode run` still reports switches.
 *
 * The definition is portable on purpose: plain JSON Schema, no Effect, no
 * server-only import. The TUI entrypoint and any external client load this
 * same module, so the wire shape cannot drift between sender and receiver.
 */

// `@opencode/plugin/rpc` and the plugin root export the same `Rpc`; the
// subpath is the one the OpenCode Desktop GUI bundle may import (the app
// provides it to plugin GUIs, the root barrel it does not).
import { Rpc } from "@opencode/plugin/rpc";

/** Notice severities, aligned with the host's toast variants. */
export const NOTICE_VARIANTS = ["info", "success", "warning", "error"] as const;

export type NoticeVariant = (typeof NOTICE_VARIANTS)[number];

/** One notice: what the client shows and which conversation it belongs to. */
export interface Notice {
	readonly sessionID?: string;
	readonly message: string;
	readonly variant: NoticeVariant;
}

/** One chain as the guide sees it (the `state` method's chain rows). */
export interface ChainState {
	readonly id: string;
	readonly name: string;
	readonly fallbacks: readonly string[];
	readonly idleReset?: string;
	readonly decisionModel?: string;
}

/** One catalog model the guide may offer as a fallback. */
export interface ModelState {
	readonly address: string;
	readonly name: string;
	readonly contextWindow?: number;
	readonly ready: boolean;
}

/** What the guide's `state` call returns. */
export interface GuideState {
	readonly chains: readonly ChainState[];
	readonly models: readonly ModelState[];
	readonly path: string;
}

/**
 * The wire is plain JSON Schema, so the host types handler inputs and client
 * results as `unknown`. These readers are the single place that turns those
 * into the interfaces above, so the server and the TUI agree on the shape and
 * a malformed payload degrades to an empty menu instead of a crash.
 */
export function readString(value: unknown, key: string): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const field = (value as Record<string, unknown>)[key];
	return typeof field === "string" ? field : undefined;
}

/** A notice event's data, or undefined when it does not look like one. */
export function readNotice(data: unknown): Notice | undefined {
	const message = readString(data, "message");
	if (message === undefined) return undefined;
	const variant = readString(data, "variant");
	const sessionID = readString(data, "sessionID");
	return {
		...(sessionID === undefined ? {} : { sessionID }),
		message,
		variant: NOTICE_VARIANTS.find((item) => item === variant) ?? "info",
	};
}

/** A `config` result; a payload the host mangled reads as a failed edit. */
export function readEdit(value: unknown): { readonly ok: boolean; readonly text: string } {
	if (typeof value !== "object" || value === null) return { ok: false, text: "switchback: no reply from the server" };
	const row = value as Record<string, unknown>;
	return {
		ok: row.ok === true,
		text: typeof row.text === "string" ? row.text : "switchback: no reply from the server",
	};
}

/** A `state` result, with non-object rows dropped rather than trusted. */
export function readGuideState(value: unknown): GuideState {
	if (typeof value !== "object" || value === null) return { chains: [], models: [], path: "" };
	const row = value as Record<string, unknown>;
	const chains: ChainState[] = [];
	for (const entry of Array.isArray(row.chains) ? row.chains : []) {
		const id = readString(entry, "id");
		const name = readString(entry, "name");
		if (id === undefined || name === undefined) continue;
		const raw = (
			Array.isArray((entry as Record<string, unknown>).fallbacks)
				? (entry as Record<string, unknown>).fallbacks
				: []
		) as unknown[];
		const idleReset = readString(entry, "idleReset");
		const decisionModel = readString(entry, "decisionModel");
		chains.push({
			id,
			name,
			fallbacks: raw.filter((item): item is string => typeof item === "string"),
			...(idleReset === undefined ? {} : { idleReset }),
			...(decisionModel === undefined ? {} : { decisionModel }),
		});
	}
	const models: ModelState[] = [];
	for (const entry of Array.isArray(row.models) ? row.models : []) {
		const address = readString(entry, "address");
		const name = readString(entry, "name");
		if (address === undefined || name === undefined) continue;
		const contextWindow = (entry as Record<string, unknown>).contextWindow;
		models.push({
			address,
			name,
			...(typeof contextWindow === "number" && contextWindow > 0 ? { contextWindow } : {}),
			ready: (entry as Record<string, unknown>).ready === true,
		});
	}
	return { chains, models, path: readString(row, "path") ?? "" };
}

const emptyObject = {
	type: "object",
	properties: {},
	required: [],
	additionalProperties: false,
} as const;

const attachment = {
	type: "object",
	properties: { attached: { type: "number" } },
	required: ["attached"],
	additionalProperties: false,
} as const;

const chain = {
	type: "object",
	properties: {
		id: { type: "string" },
		name: { type: "string" },
		fallbacks: { type: "array", items: { type: "string" } },
		idleReset: { type: "string" },
		decisionModel: { type: "string" },
	},
	required: ["id", "name", "fallbacks"],
	additionalProperties: false,
} as const;

const model = {
	type: "object",
	properties: {
		address: { type: "string" },
		name: { type: "string" },
		contextWindow: { type: "number" },
		ready: { type: "boolean" },
	},
	required: ["address", "name", "ready"],
	additionalProperties: false,
} as const;

export const SwitchbackRpc = Rpc.define({
	id: "switchback",
	methods: {
		/**
		 * Register this client as a notice sink. Called once per attached client
		 * on startup; the count decides whether the server plugin still needs the
		 * synthetic-message fallback.
		 */
		attach: { input: emptyObject, output: attachment },
		/** Release a sink (plugin unload). */
		detach: { input: emptyObject, output: attachment },
		/**
		 * Everything an interactive editor needs to render a menu: the merged
		 * chains and the models the picker may offer. Read-only, and read fresh
		 * on every request so an edit made elsewhere shows up immediately.
		 */
		state: {
			input: {
				type: "object",
				properties: { sessionID: { type: "string" } },
				required: [],
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: {
					chains: { type: "array", items: chain },
					models: { type: "array", items: model },
					/** Absolute path of the layer the server is editing. */
					path: { type: "string" },
				},
				required: ["chains", "models", "path"],
				additionalProperties: false,
			},
		},
		/**
		 * Run one `/switchback-config` verb server-side and return its result.
		 *
		 * The interactive guide is a *client* of the config grammar, not a second
		 * writer: it sends the same verb text the slash command would, and the
		 * server's single editor decides whether it lands. That is what keeps the
		 * menu and the typed command from drifting, and it is why this returns the
		 * grammar's own `ok`/`text` instead of a bespoke result.
		 */
		config: {
			input: {
				type: "object",
				properties: { text: { type: "string" }, sessionID: { type: "string" } },
				required: ["text"],
				additionalProperties: false,
			},
			output: {
				type: "object",
				properties: { ok: { type: "boolean" }, text: { type: "string" } },
				required: ["ok", "text"],
				additionalProperties: false,
			},
		},
	},
	events: {
		notice: {
			schema: {
				type: "object",
				properties: {
					sessionID: { type: "string" },
					message: { type: "string" },
					variant: { type: "string", enum: [...NOTICE_VARIANTS] },
				},
				required: ["message", "variant"],
				additionalProperties: false,
			},
		},
	},
});
