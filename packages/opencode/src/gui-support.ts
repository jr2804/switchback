/**
 * The GUI half's host-free logic: the dialog shim, notice mapping and the
 * guide entry point.
 *
 * The OpenCode Desktop GUI (`./gui-experimental`) is a *client* of the server
 * plugin, exactly like the TUI half: it attaches to the `switchback` RPC for
 * notices and for the config guide's read/write calls. Everything that decides
 * anything stays server-side, so the two clients cannot drift.
 *
 * This module holds the part worth testing - turning the app's dialog API into
 * the guide's `GuidePorts`, mapping notice severities onto toast variants, and
 * the open-the-guide sequence - and imports host types only as `import type`,
 * so vitest can drive it with a scripted dialog and no window, no Solid and no
 * bundle.
 */

import type { NoticeVariant } from "./rpc.ts";
import { readEdit, readGuideState, readNotice } from "./rpc.ts";
import { runGuide } from "./tui-guide.ts";
import type { GuideChain, GuideDialog, GuideModel, GuideOption, GuidePorts } from "./tui-guide.ts";

/**
 * The app's dialog surface, narrowed to what this plugin calls.
 *
 * `select` is the app's searchable list: it matches each option's title and
 * description itself, so the guide's own `search` hook is not forwarded - the
 * search is native, not lost.
 */
export interface GuiDialogs {
	select<Value>(options: {
		readonly title: string;
		readonly placeholder?: string;
		readonly options: readonly GuiSelectOption<Value>[];
		readonly current?: Value;
	}): Promise<Value | undefined>;
	prompt(options: {
		readonly title: string;
		readonly description?: string;
		readonly placeholder?: string;
		readonly value?: string;
		readonly secret?: boolean;
	}): Promise<string | undefined>;
	confirm(options: {
		readonly title: string;
		readonly description?: string;
		readonly confirm?: string;
		readonly cancel?: string;
		readonly danger?: boolean;
	}): Promise<boolean>;
}

/** One option of the app's select dialog. */
export interface GuiSelectOption<Value> {
	readonly title: string;
	readonly value: Value;
	readonly description?: string;
	readonly group?: string;
}

/** The RPC client of the server plugin, narrowed to the calls this plugin makes. */
export interface GuiRpcClient {
	attach(input: Record<string, never>): Promise<unknown>;
	detach(input: Record<string, never>): Promise<unknown>;
	state(input: Record<string, unknown>): Promise<unknown>;
	config(input: { readonly text: string; readonly sessionID?: string }): Promise<unknown>;
	readonly events: {
		on(name: "notice", handler: (event: { readonly data: unknown }) => void): () => void;
	};
}

/** The toast surface (`ctx.toast`), narrowed to a single show call. */
export interface GuiToast {
	show(options: {
		readonly title: string;
		readonly description?: string;
		readonly variant?: GuiToastVariant;
		readonly duration?: number;
		readonly persistent?: boolean;
	}): unknown;
}

/** Report to the user, at the guide's four severities. */
export type Say = (message: string, variant: NoticeVariant) => void;

/** Toast severities the app offers (there is no "warning" or "info"). */
export type GuiToastVariant = "default" | "success" | "error" | "loading";

/**
 * Map a notice severity onto the nearest toast variant. The app has no
 * "warning" or "info": a warning is the loud-but-not-failed case, which its
 * default variant is, and an error keeps the error styling.
 */
export function toastVariant(variant: NoticeVariant): GuiToastVariant {
	if (variant === "error") return "error";
	if (variant === "success") return "success";
	return "default";
}

/** Show one notice as a toast, titled with the notice text. */
export function showNotice(
	toast: GuiToast,
	notice: { readonly message: string; readonly variant?: NoticeVariant },
): void {
	toast.show({
		title: notice.message,
		variant: toastVariant(notice.variant ?? "info"),
	});
}
/**
 * Adapt the app's dialogs to the guide's `GuideDialog`.
 *
 * The two shapes differ in three places: the app's `confirm` takes a
 * `description` where the guide passes a `message`, the app's `confirm`
 * resolves `false` rather than `undefined` on cancel (the guide treats anything
 * but `true` as "no", so the difference is only in the type), and the app's
 * select does its own searching (the guide's `search` hook is dropped).
 */
export function guideDialog(dialogs: GuiDialogs): GuideDialog {
	return {
		select: <Value>(options: {
			readonly title: string;
			readonly placeholder?: string;
			readonly options: readonly GuideOption<Value>[];
			readonly current?: Value;
			readonly search?: (query: string, options: readonly GuideOption<Value>[]) => readonly GuideOption<Value>[];
		}): Promise<Value | undefined> =>
			dialogs.select<Value>({
				title: options.title,
				...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
				options: options.options.map((option) => ({
					title: option.title,
					value: option.value,
					...(option.description === undefined ? {} : { description: option.description }),
				})),
				...(options.current === undefined ? {} : { current: options.current }),
			}),
		prompt: (options) => dialogs.prompt(options),
		confirm: async (options) =>
			(await dialogs.confirm({ title: options.title, description: options.message })) === true,
	};
}

/** Everything the guide entry point needs from the window. */
export interface GuiGuideDeps {
	readonly dialogs: GuiDialogs;
	readonly rpc: GuiRpcClient;
	/** Show a notice to the user (toast). */
	readonly say: Say;
	/** The session the guide is editing for, when the app knows one. */
	readonly sessionID?: string;
	/** Republish providers after an edit (the server does it; this is a hint). */
	readonly reload?: () => Promise<void>;
}

/** The chains and models last read from the server, refreshed before every screen. */
export interface GuideCache {
	chains: readonly GuideChain[];
	models: readonly GuideModel[];
}

/**
 * Read the server's chains and catalog into `cache`. Errors propagate: the
 * caller decides what an unreachable server means (the guide says so and does
 * not open).
 */
export async function refreshGuide(deps: GuiGuideDeps, cache: GuideCache): Promise<void> {
	const state = readGuideState(
		await deps.rpc.state(deps.sessionID === undefined ? {} : { sessionID: deps.sessionID }),
	);
	cache.chains = state.chains;
	cache.models = state.models;
}

/**
 * Open the config guide: read the server state, then run the shared guide over
 * the app's dialogs. Every edit is sent to the server as layer-1 verb text, so
 * the GUI and the typed command go through the same writer.
 */
export async function openGuide(deps: GuiGuideDeps, cache: GuideCache = { chains: [], models: [] }): Promise<void> {
	try {
		await refreshGuide(deps, cache);
	} catch {
		deps.say("switchback: the server plugin is not reachable yet", "warning");
		return;
	}
	const ports: GuidePorts = {
		dialog: guideDialog(deps.dialogs),
		run: async (verbText) =>
			readEdit(
				await deps.rpc.config({
					text: verbText,
					...(deps.sessionID === undefined ? {} : { sessionID: deps.sessionID }),
				}),
			),
		chains: () => cache.chains,
		models: () => cache.models,
		// Both surfaces refresh from the server after an edit: the server owns the
		// parse, and a stale menu would offer a chain that no longer exists.
		reload: deps.reload ?? (() => refreshGuide(deps, cache)),
		say: (message, variant) => deps.say(message, variant),
	};
	await runGuide(ports);
}

/**
 * Subscribe to the server plugin's notices and show each as a toast.
 *
 * Returns a cleanup that detaches. Attaching first and subscribing second keeps
 * the ordering the server relies on: it only emits into a channel a client has
 * joined.
 */
export async function attachNotices(rpc: GuiRpcClient, say: Say): Promise<() => void> {
	await rpc.attach({});
	const stop = rpc.events.on("notice", (event) => {
		const notice = readNotice(event.data);
		if (notice === undefined) return;
		say(notice.message, notice.variant);
	});
	return () => {
		stop();
		void rpc.detach({}).catch(() => {
			// The server may already be gone; nothing to release.
		});
	};
}
