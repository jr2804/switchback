/**
 * Tests for the TUI half of the plugin (`packages/opencode/src/tui.ts`).
 *
 * The entrypoint is thin by design - it owns no routing - but the few things it
 * does are the ones that break silently in a real session:
 *
 *  - it must attach BEFORE subscribing, so no notice is emitted into a channel
 *    this client is not on yet;
 *  - `setup` must RETURN without waiting for the host's RPC: the attach retry
 *    schedule takes seconds, and a TUI plugin that blocks the load for that long
 *    is a visible startup stall;
 *  - a failed attach (server plugin not loaded, or the server restarted) must be
 *    retried a bounded number of times and then give up quietly - never throw
 *    into the host;
 *  - a notice event must become a toast with the same variant, and carry the
 *    sessionID only when the notice has one;
 *  - unload must detach, so the server plugin returns to the transcript instead
 *    of emitting into a dead channel.
 *
 * The suite drives `setup` with a structural fake context: no host, no TUI
 * renderer. Timers are faked so the retry schedule is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin from "../packages/opencode/src/tui.ts";

interface FakeRpc {
	attach: ReturnType<typeof vi.fn>;
	detach: ReturnType<typeof vi.fn>;
	state: ReturnType<typeof vi.fn>;
	config: ReturnType<typeof vi.fn>;
	events: { on: ReturnType<typeof vi.fn> };
}

interface FakeHost {
	toasts: unknown[];
	rpc: FakeRpc;
	context: unknown;
	emit: (data: unknown) => void;
	/** Every keymap layer the plugin registered, in order. */
	layers: unknown[];
	/** Run a registered command by id. */
	run: (id: string) => Promise<void>;
}

/** A structural stand-in for the TUI plugin context. */
function fakeHost(options?: {
	failAttachTimes?: number;
	state?: unknown;
	config?: (text: string) => unknown;
}): FakeHost {
	const toasts: unknown[] = [];
	const layers: unknown[] = [];
	let attachCalls = 0;
	let handler: ((event: { data: unknown }) => void) | undefined;
	const rpc: FakeRpc = {
		attach: vi.fn(async () => {
			attachCalls += 1;
			if (attachCalls <= (options?.failAttachTimes ?? 0)) throw new Error("server plugin not loaded");
			return { attached: 1 };
		}),
		detach: vi.fn(async () => ({ attached: 0 })),
		state: vi.fn(async () => options?.state ?? { chains: [], models: [], path: "/tmp/switchback.yaml" }),
		config: vi.fn(
			async ({ text }: { text: string }) => options?.config?.(text) ?? { ok: true, text: `ok: ${text}` },
		),
		events: {
			on: vi.fn((_name: string, registered: (event: { data: unknown }) => void) => {
				handler = registered;
				return () => {
					handler = undefined;
				};
			}),
		},
	};
	return {
		toasts,
		rpc,
		layers,
		emit: (data) => handler?.({ data }),
		run: async (id) => {
			for (const layer of layers as { commands?: readonly { id?: string; run: () => Promise<void> }[] }[]) {
				const command = layer.commands?.find((item) => item.id === id);
				if (command !== undefined) {
					await command.run();
					return;
				}
			}
			throw new Error(`no command ${id}`);
		},
		context: {
			client: { rpc: () => rpc },
			ui: {
				toast: { show: (toast: unknown) => toasts.push(toast) },
				dialog: {
					select: vi.fn(async () => undefined),
					prompt: vi.fn(async () => undefined),
					confirm: vi.fn(async () => undefined),
				},
			},
			data: { session: { list: () => [{ id: "ses_1" }] } },
			keymap: {
				layer: (factory: () => unknown) => {
					layers.push(factory());
				},
			},
		},
	};
}

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

/** Let queued microtasks and timers run so a background attach can land. */
async function settle(): Promise<void> {
	await vi.runAllTimersAsync();
	await Promise.resolve();
	await Promise.resolve();
}

describe("tui entrypoint: attach", () => {
	it("attaches and subscribes before any notice is expected", async () => {
		const host = fakeHost();
		const cleanup = await plugin.setup(host.context as never);
		await settle();
		expect(host.rpc.attach).toHaveBeenCalledTimes(1);
		expect(host.rpc.events.on).toHaveBeenCalledWith("notice", expect.any(Function));
		await cleanup?.();
	});

	it("returns from setup without waiting for the retry schedule", async () => {
		const host = fakeHost({ failAttachTimes: 1 });
		// No timer advance: if `setup` awaited the retry, this would hang.
		const cleanup = await plugin.setup(host.context as never);
		expect(host.rpc.events.on).not.toHaveBeenCalled();
		await settle();
		expect(host.rpc.events.on).toHaveBeenCalledTimes(1);
		await cleanup?.();
	});

	it("retries a failed attach and then succeeds", async () => {
		const host = fakeHost({ failAttachTimes: 2 });
		const cleanup = await plugin.setup(host.context as never);
		await settle();
		expect(host.rpc.attach).toHaveBeenCalledTimes(3);
		expect(host.rpc.events.on).toHaveBeenCalledTimes(1);
		await cleanup?.();
	});

	it("gives up quietly when the server plugin never registers", async () => {
		const host = fakeHost({ failAttachTimes: 99 });
		const cleanup = await plugin.setup(host.context as never);
		await settle();
		// Four attempts: the immediate one plus the three delayed retries.
		expect(host.rpc.attach).toHaveBeenCalledTimes(4);
		expect(host.rpc.events.on).not.toHaveBeenCalled();
		// Nothing to detach: the attach never landed.
		await cleanup?.();
		expect(host.rpc.detach).not.toHaveBeenCalled();
	});
});

describe("tui entrypoint: toasts", () => {
	it("shows each notice as a toast with its variant", async () => {
		const host = fakeHost();
		const cleanup = await plugin.setup(host.context as never);
		await settle();
		host.emit({ message: "zai/glm -> openrouter/qwen", variant: "warning", sessionID: "ses_42" });
		expect(host.toasts).toEqual([
			{
				title: "switchback",
				message: "zai/glm -> openrouter/qwen",
				variant: "warning",
				sessionID: "ses_42",
			},
		]);
		await cleanup?.();
	});

	it("omits sessionID when the notice carries none", async () => {
		const host = fakeHost();
		const cleanup = await plugin.setup(host.context as never);
		await settle();
		host.emit({ message: "all models exhausted", variant: "error" });
		expect(host.toasts).toHaveLength(1);
		expect((host.toasts[0] as { sessionID?: string }).sessionID).toBeUndefined();
		expect((host.toasts[0] as { variant: string }).variant).toBe("error");
		await cleanup?.();
	});
});

describe("tui entrypoint: unload", () => {
	it("detaches so the server falls back to the transcript", async () => {
		const host = fakeHost();
		const cleanup = await plugin.setup(host.context as never);
		await settle();
		await cleanup?.();
		expect(host.rpc.detach).toHaveBeenCalledTimes(1);
	});

	it("stops showing notices after unload", async () => {
		const host = fakeHost();
		const cleanup = await plugin.setup(host.context as never);
		await settle();
		await cleanup?.();
		host.emit({ message: "after unload", variant: "info" });
		expect(host.toasts).toHaveLength(0);
	});

	it("survives a server that is already gone at unload", async () => {
		const host = fakeHost();
		const cleanup = await plugin.setup(host.context as never);
		await settle();
		host.rpc.detach.mockRejectedValueOnce(new Error("socket closed"));
		await expect(cleanup?.()).resolves.toBeUndefined();
	});
});
