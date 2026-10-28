/**
 * Tests for the guided config editor (`packages/opencode/src/tui-guide.ts`).
 *
 * The guide is the layer-2a surface: pi's dialogue menus, reproduced on top of
 * OpenCode's dialog API. What must hold, and what breaks silently otherwise:
 *
 *  - every action turns into the layer-1 verb that means the same thing, so the
 *    menu and the typed command cannot drift (`raise` is `chain-move n n-1`,
 *    `remove` is `chain-remove n`, and so on);
 *  - cancelling is never an error and never writes: Esc at any screen returns to
 *    the previous one, and Esc from the top menu closes the guide;
 *  - a rejected edit is reported and the guide re-reads the chains, because a
 *    failed save leaves the file untouched;
 *  - the picker never offers a model already in the chain, and never offers the
 *    chain itself (that would re-enter the router).
 *
 * The suite drives the guide with a scripted dialog - a queue of answers - so
 * there is no TUI, no host and no file. The verbs it dispatches are recorded and
 * asserted as text, which is exactly the contract with layer 1.
 */

import { describe, expect, it } from "vitest";
import {
	contextLabel,
	editChain,
	modelOptions,
	runGuide,
	searchModelOptions,
} from "../packages/opencode/src/tui-guide.ts";
import type {
	GuideChain,
	GuideDialog,
	GuideEdit,
	GuideModel,
	GuideOption,
	GuidePorts,
} from "../packages/opencode/src/tui-guide.ts";

/** One scripted dialog answer, consumed in order. */
type Answer = { select: unknown } | { prompt: unknown } | { confirm: unknown };

/** A dialog that replays a queue of answers and records what it was asked. */
function scriptedDialog(answers: readonly Answer[]): {
	dialog: GuideDialog;
	asked: string[];
	remaining: () => number;
} {
	const queue = [...answers];
	const asked: string[] = [];
	const next = (kind: string): unknown => {
		const answer = queue.shift();
		if (answer === undefined) throw new Error(`unexpected ${kind} question (queue empty)`);
		const value = (answer as Record<string, unknown>)[kind];
		return value;
	};
	return {
		asked,
		remaining: () => queue.length,
		dialog: {
			async select<Value>(options: {
				readonly title: string;
				readonly options: readonly GuideOption<Value>[];
				readonly current?: Value;
				readonly search?: (
					query: string,
					options: readonly GuideOption<Value>[],
				) => readonly GuideOption<Value>[];
			}): Promise<Value | undefined> {
				asked.push(options.title);
				return next("select") as Value | undefined;
			},
			async prompt(options: { readonly title: string }): Promise<string | undefined> {
				asked.push(options.title);
				return next("prompt") as string | undefined;
			},
			async confirm(options: { readonly title: string }): Promise<boolean | undefined> {
				asked.push(options.title);
				return next("confirm") as boolean | undefined;
			},
		},
	};
}

/** A ports bundle over fixed state, recording verbs and toasts. */
function fakePorts(options: {
	answers: readonly Answer[];
	chains?: readonly GuideChain[];
	models?: readonly GuideModel[];
	edit?: (verbText: string) => GuideEdit;
}): {
	ports: GuidePorts;
	verbs: string[];
	toasts: { message: string; variant: string }[];
	reloads: number;
	dialog: ReturnType<typeof scriptedDialog>;
} {
	const scripted = scriptedDialog(options.answers);
	const verbs: string[] = [];
	const toasts: { message: string; variant: string }[] = [];
	let reloads = 0;
	const chains = options.chains ?? [];
	return {
		verbs,
		toasts,
		dialog: scripted,
		get reloads() {
			return reloads;
		},
		ports: {
			dialog: scripted.dialog,
			chains: () => chains,
			models: () => options.models ?? [],
			run: async (verbText: string) => {
				verbs.push(verbText);
				return options.edit?.(verbText) ?? { ok: true, text: "switchback: updated" };
			},
			reload: async () => {
				reloads += 1;
			},
			say: (message: string, variant: "info" | "success" | "warning" | "error") => {
				toasts.push({ message, variant });
			},
		},
	};
}

const MODELS: readonly GuideModel[] = [
	{ address: "zai/glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 200_000, ready: true },
	{ address: "openrouter/qwen3.8-max", name: "Qwen 3.8 Max", contextWindow: 1_000_000, ready: true },
	{ address: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", contextWindow: 200_000, ready: true },
];

const CHAIN: GuideChain = {
	id: "auto",
	name: "Automatic",
	fallbacks: ["zai/glm-5.3-flash", "openrouter/qwen3.8-max"],
	idleReset: "2h",
};

describe("guide: model picker", () => {
	it("labels a context window compactly", () => {
		expect(contextLabel(200_000)).toBe("200k");
		expect(contextLabel(1_000_000)).toBe("1M");
		expect(contextLabel(undefined)).toBeUndefined();
		expect(contextLabel(0)).toBeUndefined();
	});

	it("offers every catalog model, marking the ones already used", () => {
		const options = modelOptions(MODELS, ["zai/glm-5.3-flash"]);
		expect(options.map((option) => option.value)).toEqual([
			"zai/glm-5.3-flash",
			"openrouter/qwen3.8-max",
			"anthropic/claude-sonnet-5",
		]);
		// The used one is shown but flagged, so the menu still explains the chain.
		expect(options[0]?.description).toContain("in the chain");
		expect(options[1]?.description).toContain("1M");
	});

	it("searches titles and descriptions", () => {
		const options = modelOptions(MODELS);
		expect(searchModelOptions("qwen", options).map((option) => option.value)).toEqual(["openrouter/qwen3.8-max"]);
		expect(searchModelOptions("glm", options).map((option) => option.value)).toEqual(["zai/glm-5.3-flash"]);
	});
});

describe("guide: chain editing dispatches layer-1 verbs", () => {
	it("appends a picked model with chain-add", async () => {
		const host = fakePorts({
			answers: [{ select: "add" }, { select: "anthropic/claude-sonnet-5" }, { select: undefined }],
			chains: [CHAIN],
			models: MODELS,
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["chain-add auto anthropic/claude-sonnet-5"]);
		expect(host.toasts.at(-1)?.variant).toBe("success");
		expect(host.reloads).toBe(1);
	});

	it("removes a fallback by its one-based position", async () => {
		const host = fakePorts({
			answers: [{ select: "remove" }, { select: 2 }, { select: undefined }],
			chains: [CHAIN],
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["chain-remove auto 2"]);
	});

	it("raises a fallback by moving it one position up", async () => {
		const host = fakePorts({
			answers: [{ select: "raise" }, { select: 2 }, { select: undefined }],
			chains: [CHAIN],
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["chain-move auto 2 1"]);
	});

	it("lowers a fallback by moving it one position down", async () => {
		const host = fakePorts({
			answers: [{ select: "lower" }, { select: 1 }, { select: undefined }],
			chains: [CHAIN],
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["chain-move auto 1 2"]);
	});

	it("sets the idle reset from the shared option list", async () => {
		const host = fakePorts({
			answers: [{ select: "idle" }, { select: "30m" }, { select: undefined }],
			chains: [CHAIN],
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["idle-reset auto 30m"]);
	});

	it("turns the decision model off", async () => {
		const host = fakePorts({
			answers: [{ select: "decision" }, { select: null }, { select: undefined }],
			chains: [CHAIN],
			models: MODELS,
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["decision-model auto off"]);
	});

	it("renames a chain through the prompt", async () => {
		const host = fakePorts({
			answers: [{ select: "name" }, { prompt: "Fast lane" }, { select: undefined }],
			chains: [CHAIN],
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["name auto Fast lane"]);
	});

	it("does not dispatch when the first menu is cancelled", async () => {
		const host = fakePorts({ answers: [{ select: undefined }], chains: [CHAIN] });
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual([]);
		expect(host.reloads).toBe(0);
	});
});

describe("guide: rejected edits", () => {
	it("reports the failure instead of claiming success, and does not reload", async () => {
		const host = fakePorts({
			answers: [{ select: "add" }, { select: "anthropic/claude-sonnet-5" }, { select: undefined }],
			chains: [CHAIN],
			models: MODELS,
			edit: () => ({ ok: false, text: "switchback: anthropic/claude-sonnet-5 is not in the catalog" }),
		});
		await editChain(host.ports, "auto");
		expect(host.toasts.at(-1)).toEqual({
			message: "switchback: anthropic/claude-sonnet-5 is not in the catalog",
			variant: "error",
		});
		expect(host.reloads).toBe(0);
	});
});

describe("guide: top menu", () => {
	it("closes when the top menu is cancelled", async () => {
		const host = fakePorts({ answers: [{ select: undefined }], chains: [CHAIN] });
		await runGuide(host.ports);
		expect(host.verbs).toEqual([]);
	});

	it("opens the selected chain and returns to the top menu", async () => {
		const host = fakePorts({
			answers: [
				{ select: "auto" }, // top menu -> edit "auto"
				{ select: undefined }, // leave the chain menu
				{ select: undefined }, // leave the top menu
			],
			chains: [CHAIN],
		});
		await runGuide(host.ports);
		expect(host.verbs).toEqual([]);
		expect(host.dialog.remaining()).toBe(0);
	});

	it("creates a chain from the add entry", async () => {
		const host = fakePorts({
			answers: [
				{ select: null }, // "Add a chain"
				{ prompt: "fast" }, // id
				{ prompt: "Fast lane" }, // name
				{ select: "anthropic/claude-sonnet-5" }, // first fallback
				{ select: undefined }, // top menu
			],
			chains: [],
			models: MODELS,
		});
		await runGuide(host.ports);
		// `add` takes the display name as ONE token, so the dialogue adds the chain
		// under its id and renames it afterwards - two verbs, one edit.
		expect(host.verbs).toEqual(["add fast fast anthropic/claude-sonnet-5", "name fast Fast lane"]);
	});
});
