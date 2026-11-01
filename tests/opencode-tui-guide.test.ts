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
 *    chain itself (that would re-enter the router);
 *  - a decision model with connection details is followed by an offered probe
 *    (scripted - the suite never touches the network), and one without gets a
 *    warning naming the Decision providers menu, not a dead end;
 *  - the provider menu speaks the same layer-1 verbs (`provider`,
 *    `provider-remove`), so connections made by menu and by typed command are
 *    the same edit.
 *
 * The suite drives the guide with a scripted dialog - a queue of answers - so
 * there is no TUI, no host and no file. The verbs it dispatches are recorded and
 * asserted as text, which is exactly the contract with layer 1.
 */

import { describe, expect, it } from "vitest";
import type { ProbeResult } from "switchback-core";
import {
	contextLabel,
	editChain,
	editProviders,
	ENTER_ADDRESS,
	modelOptions,
	PROVIDERS_MENU,
	runGuide,
	searchModelOptions,
} from "../packages/opencode/src/tui-guide.ts";
import type {
	GuideChain,
	GuideConnections,
	GuideDialog,
	GuideEdit,
	GuideModel,
	GuideOption,
	GuidePorts,
	GuideProbe,
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
	connections?: GuideConnections;
	probe?: (connection: GuideProbe) => ProbeResult;
	edit?: (verbText: string) => GuideEdit;
}): {
	ports: GuidePorts;
	verbs: string[];
	toasts: { message: string; variant: string }[];
	reloads: number;
	probes: GuideProbe[];
	dialog: ReturnType<typeof scriptedDialog>;
} {
	const scripted = scriptedDialog(options.answers);
	const verbs: string[] = [];
	const toasts: { message: string; variant: string }[] = [];
	const probes: GuideProbe[] = [];
	let reloads = 0;
	const chains = options.chains ?? [];
	const connections = options.connections ?? { providers: [], overrides: [] };
	return {
		verbs,
		toasts,
		probes,
		dialog: scripted,
		get reloads() {
			return reloads;
		},
		ports: {
			dialog: scripted.dialog,
			chains: () => chains,
			models: () => options.models ?? [],
			connections: () => connections,
			// The scripted probe defaults to a healthy result; tests that care
			// assert on the recorded requests, never on a live endpoint.
			probeClassifier: async (connection) => {
				probes.push(connection);
				return options.probe?.(connection) ?? HEALTHY_PROBE;
			},
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

/** A probe result every shape answered, for the scripted probe port. */
const HEALTHY_PROBE: ProbeResult = {
	ok: true,
	answers: { choice: "same", score: 1, noul: true },
	missing: [],
	ms: 12,
};

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

const OLLAMA: GuideConnections = {
	providers: [{ provider: "ollama", baseUrl: "http://localhost:11434", apiKey: "local" }],
	overrides: [],
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

describe("guide: decision model with connections", () => {
	it("offers a connected address and probes it when the check is accepted", async () => {
		const host = fakePorts({
			answers: [
				{ select: "decision" }, // chain menu -> decision model
				{ select: "ollama/jev" }, // connected address, not in the catalog
				{ confirm: true }, // quick capability check
				{ select: undefined }, // leave the chain menu
			],
			chains: [{ ...CHAIN, decisionModel: "ollama/jev" }],
			models: MODELS,
			connections: OLLAMA,
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["decision-model auto ollama/jev"]);
		expect(host.probes).toEqual([
			{ baseUrl: "http://localhost:11434", apiKey: "local", provider: "ollama", id: "jev" },
		]);
		expect(host.toasts.at(-1)?.message).toContain("switchback decision-model test: ollama/jev at http://localhost:11434");
		expect(host.toasts.at(-1)?.variant).toBe("success");
	});

	it("keeps the setting when the quick check is declined", async () => {
		const host = fakePorts({
			answers: [
				{ select: "decision" },
				{ select: "ollama/jev" },
				{ confirm: false },
				{ select: undefined },
			],
			chains: [{ ...CHAIN, decisionModel: "ollama/jev" }],
			models: MODELS,
			connections: OLLAMA,
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["decision-model auto ollama/jev"]);
		expect(host.probes).toEqual([]);
	});

	it("warns, without a dead end, when the chosen address has no connection", async () => {
		const host = fakePorts({
			answers: [
				{ select: "decision" },
				{ select: "zai/glm-5.3-flash" }, // catalog model, no connection
				{ select: undefined },
			],
			chains: [CHAIN],
			models: MODELS,
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["decision-model auto zai/glm-5.3-flash"]);
		expect(host.toasts.at(-1)?.message).toContain("Decision providers");
		expect(host.toasts.at(-1)?.variant).toBe("warning");
		expect(host.dialog.remaining()).toBe(0);
	});

	it("enters a typed address through the escape option", async () => {
		const host = fakePorts({
			answers: [
				{ select: "decision" },
				{ select: ENTER_ADDRESS },
				{ prompt: "ollama/jev" },
				{ confirm: false }, // decline the quick check
				{ select: undefined },
			],
			chains: [CHAIN],
			models: MODELS,
			connections: OLLAMA,
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual(["decision-model auto ollama/jev"]);
		expect(host.probes).toEqual([]);
	});

	it("rejects a typed address that is not a provider/model id", async () => {
		const host = fakePorts({
			answers: [
				{ select: "decision" },
				{ select: ENTER_ADDRESS },
				{ prompt: "jev" }, // no provider half
				{ select: undefined },
			],
			chains: [CHAIN],
			models: MODELS,
		});
		await editChain(host.ports, "auto");
		expect(host.verbs).toEqual([]);
		expect(host.toasts.at(-1)?.message).toBe('switchback: "jev" is not a "provider/model" address');
	});
});

describe("guide: decision providers menu", () => {
	it("adds a provider through the provider verb", async () => {
		const host = fakePorts({
			answers: [
				{ select: PROVIDERS_MENU }, // top menu
				{ select: "add" },
				{ prompt: "ollama" }, // provider id
				{ prompt: "http://localhost:11434" }, // baseUrl
				{ prompt: "local" }, // api key mode
				{ select: "back" }, // leave the provider menu
				{ select: undefined }, // leave the top menu
			],
			chains: [CHAIN],
		});
		await runGuide(host.ports);
		expect(host.verbs).toEqual(["provider ollama http://localhost:11434 local"]);
	});

	it("adds a provider with a secret key reference", async () => {
		const host = fakePorts({
			answers: [
				{ select: PROVIDERS_MENU },
				{ select: "add" },
				{ prompt: "ollama" },
				{ prompt: "https://jev.example.com" },
				{ prompt: "secret:JEV_KEY" },
				{ select: "back" },
				{ select: undefined },
			],
		});
		await runGuide(host.ports);
		expect(host.verbs).toEqual(["provider ollama https://jev.example.com secret:JEV_KEY"]);
	});

	it("edits an existing connection with prefilled prompts", async () => {
		const host = fakePorts({
			answers: [
				{ select: PROVIDERS_MENU },
				{ select: "ollama" }, // provider menu
				{ select: "connection" }, // edit connection
				{ prompt: "http://127.0.0.1:11434" }, // baseUrl (prefilled, changed)
				{ prompt: "local" }, // api key mode
				{ select: "back" }, // leave the provider menu
				{ select: "back" }, // leave the provider list
				{ select: undefined }, // leave the top menu
			],
			connections: OLLAMA,
		});
		await runGuide(host.ports);
		expect(host.verbs).toEqual(["provider ollama http://127.0.0.1:11434 local"]);
	});

	it("tests a provider with a typed model id", async () => {
		const host = fakePorts({
			answers: [
				{ select: PROVIDERS_MENU },
				{ select: "ollama" },
				{ select: "test" },
				{ prompt: "ollama/jev" }, // pasted full address works too
				{ select: "back" },
				{ select: "back" },
				{ select: undefined },
			],
			connections: OLLAMA,
		});
		await runGuide(host.ports);
		expect(host.verbs).toEqual([]);
		expect(host.probes).toEqual([
			{ baseUrl: "http://localhost:11434", apiKey: "local", provider: "ollama", id: "jev" },
		]);
		expect(host.toasts.at(-1)?.message).toContain("switchback decision-model test: ollama/jev at http://localhost:11434");
	});

	it("removes a provider after confirming", async () => {
		const host = fakePorts({
			answers: [
				{ select: PROVIDERS_MENU },
				{ select: "ollama" },
				{ select: "remove" },
				{ confirm: true },
				{ select: "back" },
				{ select: undefined },
			],
			chains: [{ ...CHAIN, decisionModel: "ollama/jev" }],
			connections: OLLAMA,
		});
		await runGuide(host.ports);
		expect(host.verbs).toEqual(["provider-remove ollama"]);
	});

	it("keeps the provider when the removal is cancelled", async () => {
		const host = fakePorts({
			answers: [
				{ select: PROVIDERS_MENU },
				{ select: "ollama" },
				{ select: "remove" },
				{ confirm: false },
				{ select: "back" },
				{ select: "back" },
				{ select: undefined },
			],
			connections: OLLAMA,
		});
		await runGuide(host.ports);
		expect(host.verbs).toEqual([]);
	});

	it("leaves the provider menu without dispatching", async () => {
		const host = fakePorts({
			answers: [
				{ select: PROVIDERS_MENU },
				{ select: "back" },
				{ select: undefined },
			],
			connections: OLLAMA,
		});
		await runGuide(host.ports);
		expect(host.verbs).toEqual([]);
		expect(host.dialog.remaining()).toBe(0);
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
