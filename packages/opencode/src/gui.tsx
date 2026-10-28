/**
 * The GUI half of the plugin (layer 2b): `./gui-experimental` for OpenCode
 * Desktop.
 *
 * It is the same client as the TUI half, with the app's own widgets: notices
 * arrive as toasts, and `/switchback-config` opens the shared guided editor over
 * the app's dialogs. Nothing decides here - the server plugin owns routing, the
 * config grammar owns every write, and the guide's navigation is the shared
 * `./tui-guide.ts` - so the three surfaces cannot drift.
 *
 * This file is the bundle's entry point and stays a thin registration layer:
 * everything with logic lives in `./gui-support.ts`, which imports host types
 * only as types and is therefore testable without Solid or a window.
 */

import { Command, Plugin } from "@opencode/plugin/gui";
import { attachNotices, openGuide, showNotice } from "./gui-support.ts";
import type { GuiRpcClient, Say } from "./gui-support.ts";
import { SwitchbackRpc } from "./rpc.ts";

/** How a client retries a failed attach: a bounded wait, not a hot loop. */
const RETRY_DELAYS_MS = [500, 2_000, 5_000] as const;

/** Wait, but never longer than the caller's remaining patience. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export default Plugin.define({
	setup(ctx) {
		let detached = false;
		let stop: (() => void) | undefined;

		/** The server plugin's RPC. Read through `ctx.client` each time: it follows server restarts. */
		const rpc = (): GuiRpcClient => ctx.client.rpc(SwitchbackRpc) as unknown as GuiRpcClient;

		const say: Say = (message, variant) => {
			showNotice(ctx.toast, { message, variant });
		};

		const attach = async (): Promise<void> => {
			for (const delay of [0, ...RETRY_DELAYS_MS]) {
				if (detached) return;
				if (delay > 0) await sleep(delay);
				if (detached) return;
				try {
					stop = await attachNotices(rpc(), say);
					return;
				} catch {
					// The server plugin is not loaded yet, or the server restarted.
				}
			}
		};

		// `setup` is synchronous and must not wait on the RPC: the retry schedule
		// takes seconds, and a window that blocked on it would delay the plugin.
		void attach();

		ctx.add(Command, () => ({
			id: "config",
			title: "Switchback configuration",
			description: "Pick chains and fallbacks from the model catalog",
			group: "Switchback",
			section: "model" as const,
			slash: { name: "switchback-config" },
			// The server plugin republishes the virtual models itself after every
			// successful edit, so the guide has nothing to reload here.
			run: () => openGuide({ dialogs: ctx.dialogs, rpc: rpc(), say }),
		}));

		return () => {
			detached = true;
			stop?.();
		};
	},
});
