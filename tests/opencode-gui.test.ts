/**
 * Tests for the GUI half's host-free logic (`packages/opencode/src/gui-support.ts`).
 *
 * The GUI bundle cannot be imported here: it is Solid JSX compiled into one CJS
 * file, and it needs a window. So the layer that must be right - adapting the
 * app's dialogs to the guide, mapping notice severities onto toast variants, the
 * attach-then-subscribe ordering, and what a dead server does - is kept in a
 * plain module and tested directly.
 *
 * The rules under test, and what breaks silently otherwise:
 *
 *  - every guide edit still reaches the server as layer-1 verb text, so the GUI
 *    and the typed command cannot drift;
 *  - the app's dialogs and the guide's dialog contract are adapted rather than
 *    duplicated (`message` becomes `description`, the app's native search
 *    replaces the guide's `search` hook, cancel is `false`);
 *  - a notice keeps its severity through the toast variant map, because the app
 *    has no "warning" or "info";
 *  - the client attaches before it subscribes, so no notice is emitted into a
 *    channel it has not joined;
 *  - an unreachable server says so and changes nothing.
 */

import { describe, expect, it } from "vitest";
import {
	attachNotices,
	guideDialog,
	openGuide,
	refreshGuide,
	showNotice,
	toastVariant,
} from "../packages/opencode/src/gui-support.ts";
import type { GuiDialogs, GuiRpcClient, GuiSelectOption } from "../packages/opencode/src/gui-support.ts";
import type { NoticeVariant } from "../packages/opencode/src/rpc.ts";
import type { Notice } from "../packages/opencode/src/rpc.ts";

/** A recorded toast. */
interface ShownToast {
	readonly title: string;
	readonly description?: string;
	readonly variant?: string;
}

/** A recorded `config` RPC call. */
interface ConfigCall {
	readonly text: string;
	readonly sessionID?: string;
}

/**
 * A dialog that replays answers and records what it was asked. It implements
 * the app's `Dialogs` subset exactly as the app does: `confirm` resolves
 * `false` on cancel, never `undefined`.
 */
function scriptedDialogs(
	answers: readonly { readonly pick?: unknown; readonly prompt?: unknown; readonly confirm?: unknown }[],
): {
	dialogs: GuiDialogs;
	asked: string[];
} {
	const queue = [...answers];
	const asked: string[] = [];
	const next = (kind: "pick" | "prompt" | "confirm"): unknown => {
		const answer = queue.shift();
		if (answer === undefined) throw new Error(`unexpected ${kind} question (queue empty)`);
		return answer[kind];
	};
	return {
		asked,
		dialogs: {
			async select<Value>(options: {
				readonly title: string;
				readonly options: readonly GuiSelectOption<Value>[];
			}): Promise<Value | undefined> {
				asked.push(`select: ${options.title}`);
				return next("pick") as Value | undefined;
			},
			async prompt(options: { readonly title: string }): Promise<string | undefined> {
				asked.push(`prompt: ${options.title}`);
				return next("prompt") as string | undefined;
			},
			async confirm(options: { readonly title: string }): Promise<boolean> {
				asked.push(`confirm: ${options.title}`);
				return next("confirm") === true;
			},
		},
	};
}

/** The state the fake server reports. */
interface FakeState {
	readonly chains: readonly { id: string; name: string; fallbacks: readonly string[] }[];
	readonly models: readonly { address: string; name: string; ready: boolean }[];
}

/**
 * A fake server RPC: it answers `state` from a mutable fixture, applies every
 * `config` text to the recorded list, and emits notices on demand. The call
 * order is recorded, because "attach before subscribe" is a rule.
 */
function fakeRpc(state: FakeState): {
	rpc: GuiRpcClient;
	edits: ConfigCall[];
	order: string[];
	emit: (notice: Notice) => void;
	stateCalls: Record<string, unknown>[];
	/** Set to make every call reject, as an unreachable server does. */
	fail: () => void;
} {
	const edits: ConfigCall[] = [];
	const order: string[] = [];
	const stateCalls: Record<string, unknown>[] = [];
	const handlers: ((event: { readonly data: unknown }) => void)[] = [];
	let failing = false;
	const guard = <T>(value: T): Promise<T> =>
		failing ? Promise.reject(new Error("unreachable")) : Promise.resolve(value);
	return {
		edits,
		order,
		stateCalls,
		fail: () => {
			failing = true;
		},
		emit: (notice) => {
			for (const handler of handlers) handler({ data: notice });
		},
		rpc: {
			attach: async () => {
				order.push("attach");
				return guard({});
			},
			detach: async () => {
				order.push("detach");
				return guard({});
			},
			state: async (input) => {
				order.push("state");
				stateCalls.push(input);
				return guard({ ...state, path: "switchback.yaml" });
			},
			config: async (input) => {
				order.push("config");
				edits.push(input);
				return guard({ ok: true, text: `switchback: ${input.text}` });
			},
			events: {
				on: (name, handler) => {
					expect(name).toBe("notice");
					order.push("subscribe");
					handlers.push(handler);
					return () => {
						order.push("unsubscribe");
						handlers.splice(handlers.indexOf(handler), 1);
					};
				},
			},
		},
	};
}

const STATE: FakeState = {
	chains: [{ id: "auto", name: "Auto", fallbacks: ["zai/glm-5.3-flash"] }],
	models: [
		{ address: "zai/glm-5.3-flash", name: "GLM 5.3 Flash", ready: true },
		{ address: "openrouter/muse-spark", name: "Muse Spark", ready: false },
	],
};

describe("toast variants", () => {
	it("keeps error and success, and folds warning and info into the default tone", () => {
		expect(toastVariant("error")).toBe("error");
		expect(toastVariant("success")).toBe("success");
		// The app has no warning or info: a warning is loud but did not fail, which
		// is what the default tone says.
		expect(toastVariant("warning")).toBe("default");
		expect(toastVariant("info")).toBe("default");
	});

	it("titles the toast with the notice text and defaults the severity to info", () => {
		const shown: ShownToast[] = [];
		showNotice({ show: (options) => shown.push(options) }, { message: "switched to openrouter/muse-spark" });
		expect(shown).toEqual([{ title: "switched to openrouter/muse-spark", variant: "default" }]);
	});

	it("passes an error notice through as an error toast", () => {
		const shown: ShownToast[] = [];
		showNotice({ show: (options) => shown.push(options) }, { message: "no fallback left", variant: "error" });
		expect(shown[0]?.variant).toBe("error");
	});
});

describe("the app's dialogs as the guide's dialog", () => {
	it("turns the guide's confirm message into the app's description and cancel into false", async () => {
		const seen: { title: string; description?: string }[] = [];
		const dialog = guideDialog({
			select: async () => undefined,
			prompt: async () => undefined,
			confirm: async (options) => {
				seen.push(options);
				// The app resolves false, never undefined, on cancel.
				return false;
			},
		});
		expect(await dialog.confirm({ title: "remove auto?", message: "Auto and its 1 fallback(s)" })).toBe(false);
		expect(seen).toEqual([{ title: "remove auto?", description: "Auto and its 1 fallback(s)" }]);
	});

	it("drops the guide's search hook, because the app's select searches natively", async () => {
		const seen: {
			title: string;
			placeholder?: string;
			options: readonly GuiSelectOption<string>[];
			current?: string;
		}[] = [];
		const dialog = guideDialog({
			select: async (options) => {
				seen.push(options);
				return options.options[1]?.value;
			},
			prompt: async () => undefined,
			confirm: async () => false,
		});
		const picked = await dialog.select<string>({
			title: "add a fallback to auto",
			placeholder: "type to search models",
			options: [
				{ title: "zai/glm-5.3-flash", value: "zai/glm-5.3-flash", description: "GLM 5.3 Flash" },
				{ title: "openrouter/muse-spark", value: "openrouter/muse-spark" },
			],
			current: "zai/glm-5.3-flash",
			search: () => [],
		});
		expect(picked).toBe("openrouter/muse-spark");
		expect(seen).toEqual([
			{
				title: "add a fallback to auto",
				placeholder: "type to search models",
				options: [
					{ title: "zai/glm-5.3-flash", value: "zai/glm-5.3-flash", description: "GLM 5.3 Flash" },
					{ title: "openrouter/muse-spark", value: "openrouter/muse-spark" },
				],
				current: "zai/glm-5.3-flash",
			},
		]);
	});
});

describe("the guide over the GUI", () => {
	it("reads the server state, then sends the picked action back as layer-1 verb text", async () => {
		const server = fakeRpc(STATE);
		const { dialogs } = scriptedDialogs([
			// Top menu: pick the chain.
			{ pick: "auto" },
			// Chain menu: add a fallback.
			{ pick: "add" },
			// Model picker: the second catalog model.
			{ pick: "openrouter/muse-spark" },
			// Back in the chain menu (the add is one action, not a loop): leave.
			{ pick: "back" },
			// Top menu: cancel.
			{ pick: undefined },
		]);
		const said: string[] = [];
		await openGuide({
			dialogs,
			rpc: server.rpc,
			say: (message) => said.push(message),
			sessionID: "ses_1",
		});
		expect(server.edits.map((call) => call.text)).toEqual(["chain-add auto openrouter/muse-spark"]);
		// Once to open the guide, once more after the edit so the next screen is current.
		expect(server.stateCalls).toEqual([{ sessionID: "ses_1" }, { sessionID: "ses_1" }]);
		// The server's own confirmation is what the user sees, not a local guess.
		expect(said).toEqual(["switchback: chain-add auto openrouter/muse-spark"]);
	});

	it("reports a rejected edit and keeps going, because a failed save leaves the file alone", async () => {
		const server = fakeRpc(STATE);
		const original = server.rpc.config;
		(server.rpc as { config: GuiRpcClient["config"] }).config = async (input) => {
			await original(input);
			return { ok: false, text: "switchback: unknown model zai/nope" };
		};
		const { dialogs } = scriptedDialogs([
			{ pick: "auto" },
			{ pick: "add" },
			{ pick: "zai/nope" },
			{ pick: "back" },
			{ pick: undefined },
		]);
		const said: string[] = [];
		await openGuide({ dialogs, rpc: server.rpc, say: (message) => said.push(message) });
		expect(said).toEqual(["switchback: unknown model zai/nope"]);
	});

	it("says the server is unreachable and opens nothing when the state call fails", async () => {
		const server = fakeRpc(STATE);
		server.fail();
		const { dialogs, asked } = scriptedDialogs([]);
		const said: string[] = [];
		await openGuide({ dialogs, rpc: server.rpc, say: (message) => said.push(message) });
		expect(said).toEqual(["switchback: the server plugin is not reachable yet"]);
		expect(asked).toEqual([]);
		expect(server.edits).toEqual([]);
	});

	it("refreshes the cache from the server before the guide reads it", async () => {
		const server = fakeRpc(STATE);
		const cache = { chains: [], models: [] };
		await refreshGuide({ dialogs: scriptedDialogs([]).dialogs, rpc: server.rpc, say: () => {} }, cache);
		expect(cache.chains.map((chain) => chain.id)).toEqual(["auto"]);
		expect(cache.models.map((model) => model.address)).toEqual(["zai/glm-5.3-flash", "openrouter/muse-spark"]);
	});
});

describe("notice delivery", () => {
	it("attaches before it subscribes, so no notice lands in a channel the client has not joined", async () => {
		const server = fakeRpc(STATE);
		const stop = await attachNotices(server.rpc, () => {});
		expect(server.order).toEqual(["attach", "subscribe"]);
		stop();
		await Promise.resolve();
		expect(server.order).toEqual(["attach", "subscribe", "unsubscribe", "detach"]);
	});

	it("shows each notice with its own severity and ignores malformed payloads", async () => {
		const server = fakeRpc(STATE);
		const seen: { message: string; variant: NoticeVariant }[] = [];
		const stop = await attachNotices(server.rpc, (message, variant) => seen.push({ message, variant }));
		server.emit({ message: "switched to openrouter/muse-spark", variant: "warning" });
		server.emit({ message: "all fallbacks blocked", variant: "error" });
		// A payload without a message is not a notice; it must not reach the user.
		server.emit({} as Notice);
		expect(seen).toEqual([
			{ message: "switched to openrouter/muse-spark", variant: "warning" },
			{ message: "all fallbacks blocked", variant: "error" },
		]);
		stop();
	});

	it("detaching does not throw when the server is already gone", async () => {
		const server = fakeRpc(STATE);
		const stop = await attachNotices(server.rpc, () => {});
		server.fail();
		expect(() => stop()).not.toThrow();
		// The rejected detach is swallowed, not left as an unhandled rejection.
		await Promise.resolve();
	});
});
