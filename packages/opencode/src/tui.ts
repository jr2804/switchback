/**
 * The TUI half of the plugin: real toasts for switchback notices, plus the
 * guided config editor.
 *
 * The server plugin can only write into the transcript, which is the wrong
 * surface for "switched to X mid-turn": it reads like the model said it. This
 * entrypoint attaches to the server plugin's `switchback` RPC and turns every
 * notice into a toast, and it serves `/switchback-config` as an interactive
 * menu driven by the server's config grammar (`./tui-guide.ts`).
 *
 * It owns no routing and writes no files: notices are decided server-side, and
 * every edit is sent back as layer-1 verb text for the server's single editor
 * to apply. That is what keeps the menu and the typed command from drifting.
 *
 * Notice delivery is best effort in both directions. A TUI that loads before
 * the server plugin registered its RPC, or after a server restart, simply
 * retries - a missing toast must never disturb a session.
 */

import type { Definition } from "@opencode/plugin/tui/plugin";
import type { Context } from "@opencode/plugin/tui/context";
import { readEdit, readGuideState, readNotice, SwitchbackRpc } from "./rpc.ts";
import type { NoticeVariant } from "./rpc.ts";
import { runGuide } from "./tui-guide.ts";
import type { GuideChain, GuideModel, GuidePorts } from "./tui-guide.ts";

/**
 * `Plugin.define` is an identity function; importing it from the package root
 * would also pull the Solid renderer into the module graph, which the server
 * half and the tests must not need.
 */
function define<D extends Definition>(plugin: D): D {
	return plugin;
}

/** How a client retries a failed attach: a bounded wait, not a hot loop. */
const RETRY_DELAYS_MS = [500, 2_000, 5_000] as const;

/** Wait, but never longer than the caller's remaining patience. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default define({
	id: "switchback",
	async setup(context: Context) {
		const rpc = context.client.rpc(SwitchbackRpc);
		let attached = false;
		let disposed = false;
		let stop: (() => void) | undefined;

		const show = (notice: { sessionID?: string; message: string; variant?: NoticeVariant }): void => {
			context.ui.toast.show({
				title: "switchback",
				message: notice.message,
				variant: notice.variant ?? "info",
				...(notice.sessionID === undefined ? {} : { sessionID: notice.sessionID }),
			});
		};

		const attach = async (): Promise<void> => {
			for (const delay of [0, ...RETRY_DELAYS_MS]) {
				if (disposed) return;
				if (delay > 0) await sleep(delay);
				if (disposed) return;
				try {
					await rpc.attach({});
					attached = true;
					// Subscribe only after the server knows a sink exists, so no
					// notice is emitted into a channel this client is not on yet.
					stop = rpc.events.on("notice", (event) => {
						const notice = readNotice(event.data);
						if (notice !== undefined) show(notice);
					});
					return;
				} catch {
					// Server plugin not loaded yet (or the server restarted).
				}
			}
		};

		// `setup` must not wait on the host's RPC being reachable: the retry
		// schedule can take seconds, and a TUI that blocks on it would delay the
		// whole plugin load. Notices that arrive before the attach lands fall back
		// to the transcript, which is what a client without a toast gets anyway.
		void attach();

		/**
		 * The guide's ports. `chains`/`models` are read from the server on every
		 * menu because an edit changes them, and the state call is cheap.
		 */
		const ports = (): GuidePorts => ({
			dialog: context.ui.dialog,
			run: async (verbText) => readEdit(await rpc.config({ text: verbText })),
			chains: () => stateCache.chains,
			models: () => stateCache.models,
			reload: async () => refresh(),
			say: (message, variant) => show({ message, variant }),
		});

		/** Last-read server state; refreshed before every screen. */
		const stateCache: { chains: readonly GuideChain[]; models: readonly GuideModel[] } = {
			chains: [],
			models: [],
		};

		const refresh = async (sessionID?: string): Promise<void> => {
			const state = readGuideState(await rpc.state(sessionID === undefined ? {} : { sessionID }));
			stateCache.chains = state.chains;
			stateCache.models = state.models;
		};

		const openGuide = async (): Promise<void> => {
			const sessionID = context.data.session.list().find((s) => s.id !== undefined)?.id;
			try {
				await refresh(sessionID);
			} catch {
				show({ message: "switchback: the server plugin is not reachable yet", variant: "warning" });
				return;
			}
			await runGuide(ports());
		};

		// The slash command lives in the client keymap: the server's commands run
		// as one shot, and this one has to open a dialog and stay open.
		context.keymap.layer(() => ({
			commands: [
				{
					id: "switchback.config",
					title: "Switchback configuration",
					description: "Pick chains and fallbacks from the model catalog",
					group: "Switchback",
					slash: { name: "switchback-config" },
					run: () => openGuide(),
				},
			],
		}));

		return async () => {
			disposed = true;
			stop?.();
			if (!attached) return;
			await rpc.detach({}).catch(() => {
				// The server may already be gone; nothing to release.
			});
		};
	},
});
