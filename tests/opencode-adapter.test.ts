/**
 * Tests for the OpenCode adapter (packages/opencode/src).
 *
 * The new architecture is a provider package + plugin pair: the plugin
 * (`index.ts` + `router.ts`) publishes a `switchback` provider whose models
 * are the configured chains, and a bridge that answers the provider package's
 * (`route.ts`) routing questions with core `decide()` verdicts. The suite
 * drives `Plugin.define(...).setup()` against a hand-built context double and
 * then talks to the published bridge directly - the same seam the live host
 * uses.
 *
 * Hermetic: SWITCHBACK_DIR, PI_CODING_AGENT_DIR and USERPROFILE all move into
 * a temp dir (switchbackStateDir, piConfigDir and the neutral ~/.config basis
 * derive from those variables), so blocks.json/switchback.yaml never touch
 * the real user state. USERPROFILE redirection is the Windows path — this
 * suite intentionally runs on the dev box (win32).
 *
 * The classifier endpoint is a stubbed globalThis.fetch (the port reaches it
 * via systemOneClassifierPort -> systemOneClassifier -> ambient fetch) that
 * returns a canned structured answer. Per root AGENTS.md rule 1 the canned
 * answer is the decision's only source: the suite asserts the WIRING
 * (classify call happened, verdict drove block/advance), never a specific
 * model's real-world behaviour.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir as osTmpdir } from "node:os";
import plugin from "opencode-switchback";
import { readBridge } from "../packages/opencode/src/bridge.ts";
import { appliedLevel, debugLog } from "../packages/opencode/src/route.ts";
import { SWITCHBACK_DIR_ENV } from "switchback-core/config.ts";
import { pinFilePath, stateFilePath } from "switchback-core";

const TMP_ROOT = join(osTmpdir(), "switchback-opencode-tests");

let tmp: string;
let stateDir: string;
let agentDir: string;
let fetchSpy: ReturnType<typeof vi.fn>;

/** Canned structured answer: quota on the account, no reset time mentioned. */
const CANNED_ANSWERS = {
	model: "jev-fixture",
	usage: { input_tokens: 9, output_tokens: 3 },
	answers: {
		class: { type: "choice", choice: "quota", confidence: 0.9, probabilities: { quota: 1 } },
		reset: { type: "score", score: 0, confidence: 0.8 },
		scope: { type: "choice", choice: "account", confidence: 0.9, probabilities: { account: 1 } },
	},
};

const QUA_ERR = "usage limit reached for this account (quota)";

/** Two-entry catalog: alpha fails in the fixtures, beta is the fallback. */
const CATALOG = [
	{
		id: "alpha-corp/alpha-model",
		modelID: "alpha-model",
		providerID: "alpha-corp",
		name: "Alpha",
		enabled: true,
		limit: { context: 128_000 },
	},
	{
		id: "beta-corp/beta-model",
		modelID: "beta-model",
		providerID: "beta-corp",
		name: "Beta",
		enabled: true,
		limit: { context: 128_000 },
	},
];

/**
 * Config in the SHARED global layer (`<SWITCHBACK_CONFIG_DIR>/switchback.yaml`).
 *
 * Deliberately not the agent-overlay layer: OpenCode passes no layer dirs and so
 * must never read `~/.pi/agent/switchback.yaml` (beads `switchback-wix.12`).
 * Writing here is what proves the adapter honours the shared file.
 */
function writeConfig(extra = ""): void {
	writeFileSync(
		join(process.env["SWITCHBACK_CONFIG_DIR"] ?? tmp, "switchback.yaml"),
		`models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - alpha-corp/alpha-model
      - beta-corp/beta-model
    decisionModel: fixture/jev
decisionModels:
  fixture/jev:
    baseUrl: http://classifier.invalid/v1
    apiKey: fixture-key
${extra}`,
	);
}

beforeEach(() => {
	mkdirSync(TMP_ROOT, { recursive: true });
	tmp = join(TMP_ROOT, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	stateDir = join(tmp, "state");
	agentDir = join(tmp, "agent");
	mkdirSync(stateDir, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	process.env[SWITCHBACK_DIR_ENV] = stateDir;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	// Redirect the neutral ~/.config basis too: os.homedir() honours USERPROFILE on Windows.
	process.env.USERPROFILE = tmp;
	process.env["SWITCHBACK_CONFIG_DIR"] = tmp;
	fetchSpy = vi.fn(
		async (_url: unknown, _init?: unknown) =>
			new Response(JSON.stringify(CANNED_ANSWERS), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env[SWITCHBACK_DIR_ENV];
	delete process.env.PI_CODING_AGENT_DIR;
	delete process.env.USERPROFILE;
	delete process.env["SWITCHBACK_CONFIG_DIR"];
	rmSync(tmp, { recursive: true, force: true });
});

interface EditorSpy {
	add: ReturnType<typeof vi.fn>;
	modelsSet: ReturnType<typeof vi.fn>;
	update: ReturnType<typeof vi.fn>;
}

/** Stand-in for Plugin.Context, narrowed to the pieces this adapter consumes. */
function fakeCtx(catalog: typeof CATALOG, synthetic: ReturnType<typeof vi.fn>) {
	const commands = new Map<string, (input: { sessionID: string; prompt: { text: string } }) => Promise<void>>();
	const editors: EditorSpy[] = [];
	/** Per-session selected model, as the host records it on the session. */
	const selection = new Map<string, { providerID: string; id: string }>();
	/** Per-session message list, as `session.context` reports it. */
	const history = new Map<string, readonly unknown[]>();
	/** Notices that reached an attached client instead of the transcript. */
	const toasts: unknown[] = [];
	const ctx = {
		session: {
			synthetic: async (input: { sessionID: string; text: string }) => {
				synthetic(input);
			},
			get: async (input: { sessionID: string }) => ({ model: selection.get(input.sessionID) }),
			context: async (input: { sessionID: string }) => history.get(input.sessionID) ?? [],
		},
		// The notice RPC the TUI attaches to. Left UNATTACHED by default, which is
		// the headless rule: with no client listening, notices go to the transcript
		// (`session.synthetic`) and the existing assertions below see them there.
		rpc: {
			register: async (_definition: unknown, handlers: Record<string, () => Promise<{ attached: number }>>) => ({
				events: {
					emit: async (_name: string, data: unknown) => {
						toasts.push(data);
					},
				},
				/** Let a test attach a sink mid-run, as a TUI plugin would. */
				attachSink: async () => handlers.attach?.(),
				/** And release it again. */
				detachSink: async () => handlers.detach?.(),
			}),
		},
		model: { list: async () => ({ data: catalog }) },
		command: {
			transform: (
				edit: (editor: {
					add: (def: {
						name: string;
						description: string;
						execute: (input: { sessionID: string; prompt: { text: string } }) => Promise<void>;
					}) => void;
				}) => void,
			) => {
				edit({
					add: (def) => {
						commands.set(def.name, def.execute);
					},
				});
			},
		},
		provider: {
			list: async () => ({ data: [] }),
			transform: (edit: (editor: unknown) => Promise<void> | void) => {
				const spy: EditorSpy = {
					add: vi.fn(),
					modelsSet: vi.fn(),
					update: vi.fn(),
				};
				void edit({
					list: () => [],
					add: spy.add,
					update: spy.update,
					models: { set: spy.modelsSet },
				});
				editors.push(spy);
			},
		},
	};
	return { ctx, commands, editors, selection, history, toasts };
}

async function setup(catalog: typeof CATALOG = CATALOG, synthetic: ReturnType<typeof vi.fn> = vi.fn()) {
	writeConfig();
	const built = fakeCtx(catalog, synthetic);
	await plugin.setup(built.ctx as unknown as never);
	return built;
}

function notices(synthetic: ReturnType<typeof vi.fn>): string[] {
	return synthetic.mock.calls.map((call) => (call[0] as { text: string }).text);
}

describe("provider publishing", () => {
	it("publishes the chains as selector-visible switchback models with level variants", async () => {
		const { editors } = await setup();
		expect(editors.length).toBeGreaterThan(0);
		const spy = editors[0]!;
		expect(spy.add).toHaveBeenCalledTimes(1);
		const record = spy.add.mock.calls[0]![0] as {
			info: { id: string; name: string; activation: string; package: string };
			models: { id: string; name: string; package: string; variants: { id: string }[] }[];
		};
		expect(record.info).toMatchObject({ id: "switchback", activation: "enabled", package: "opencode-switchback" });
		expect(record.models).toHaveLength(1);
		const model = record.models[0]!;
		// Catalog ids are provider-relative: the host already scopes them by the
		// switchback provider (selector shows "switchback/auto").
		expect(model.id).toBe("auto");
		expect(model.package).toBe("opencode-switchback");
		expect(model.variants.map((v) => v.id)).toContain("off");
		expect(model.variants.map((v) => v.id)).toContain("high");
	});
});

describe("bridge routing", () => {
	it("routes the first dispatch to the head of the chain", async () => {
		await setup();
		const bridge = readBridge();
		expect(bridge).toBeDefined();
		const answer = await bridge!.route({ chainId: "switchback/auto", sessionKey: "ses-a", reason: "user" });
		expect(answer).toMatchObject({ status: "ok", current: "alpha-corp/alpha-model" });
	});

	it("announces an unconnected decision model on the route, once", async () => {
		// No decisionModels connection at all. The gap must surface on the
		// switchback route - the one conversation actually using switchback -
		// never at plugin setup, which runs on every boot for sessions that
		// never select a switchback model.
		writeFileSync(
			join(process.env["SWITCHBACK_CONFIG_DIR"] ?? tmp, "switchback.yaml"),
			`models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - alpha-corp/alpha-model
      - beta-corp/beta-model
    decisionModel: fixture/jev
decisionModels:
  fixture/jev: {}
`,
		);
		const synthetic = vi.fn();
		// Not setup(): it unconditionally rewrites the connected fixture config,
		// which would clobber the unconnected YAML above.
		const built = fakeCtx(CATALOG, synthetic);
		await plugin.setup(built.ctx as unknown as never);
		const bridge = readBridge();
		const answer = await bridge!.route({ chainId: "switchback/auto", sessionKey: "ses-warn", reason: "user" });
		// The gap degrades classification, not routing: the chain still answers.
		expect(answer).toMatchObject({ status: "ok", current: "alpha-corp/alpha-model" });
		// The routing session receives the warning by name even on its FIRST
		// route (it is not in the fan-out state map until a decision is recorded).
		const gapNotices = notices(synthetic).filter((text) => text.includes("has no connection details"));
		expect(gapNotices).toHaveLength(1);
		expect(gapNotices[0]).toContain("decisionProviders.fixture");
		// A second route with the same finding does not repeat the notice.
		await bridge!.route({ chainId: "switchback/auto", sessionKey: "ses-warn", reason: "user" });
		expect(notices(synthetic).filter((text) => text.includes("has no connection details"))).toHaveLength(1);
	});

	it("blocks the failed model and advances on a quota verdict", async () => {
		const synthetic = vi.fn();
		await setup(CATALOG, synthetic);
		const bridge = readBridge();
		const answer = await bridge!.route({
			chainId: "switchback/auto",
			sessionKey: "ses-b",
			reason: "retry",
			failed: { modelId: "alpha-corp/alpha-model", message: QUA_ERR },
		});
		expect(answer).toMatchObject({ status: "ok", current: "beta-corp/beta-model" });
		// The verdict's side effect: the account-scoped block map now holds alpha.
		expect(existsSync(stateFilePath())).toBe(true);
		const blocked = JSON.parse(readFileSync(stateFilePath(), "utf8")) as Record<string, number>;
		expect(Object.keys(blocked)).toContain("alpha-corp/alpha-model");
		// The classifier was actually consulted (wiring, not a keyword shortcut).
		expect(fetchSpy).toHaveBeenCalled();
		// And the switch was announced in-band.
		expect(notices(synthetic).some((text) => text.includes("beta-corp/beta-model"))).toBe(true);
	});

	it("stays sticky on the current model for later turns", async () => {
		await setup();
		const bridge = readBridge();
		const first = await bridge!.route({ chainId: "switchback/auto", sessionKey: "ses-c", reason: "user" });
		expect(first).toMatchObject({ status: "ok", current: "alpha-corp/alpha-model" });
		const second = await bridge!.route({ chainId: "switchback/auto", sessionKey: "ses-c", reason: "user" });
		expect(second).toMatchObject({ status: "ok", current: "alpha-corp/alpha-model" });
	});

	it("surfaces exhausted when every effective entry is blocked", async () => {
		await setup();
		const bridge = readBridge();
		await bridge!.route({ chainId: "switchback/auto", sessionKey: "ses-d", reason: "user" });
		await bridge!.route({
			chainId: "switchback/auto",
			sessionKey: "ses-d",
			reason: "retry",
			failed: { modelId: "alpha-corp/alpha-model", message: QUA_ERR },
		});
		const answer = await bridge!.route({
			chainId: "switchback/auto",
			sessionKey: "ses-d",
			reason: "retry",
			failed: { modelId: "beta-corp/beta-model", message: QUA_ERR },
		});
		expect(answer).toMatchObject({ status: "exhausted" });
	});

	it("reports config-invalid for a chain with no effective entries", async () => {
		writeConfig();
		const broken = [
			{
				id: "ghost-corp/ghost-model",
				modelID: "ghost-model",
				providerID: "ghost-corp",
				name: "Ghost",
				enabled: true,
				limit: { context: 1 },
			},
		];
		const built = fakeCtx(broken, vi.fn());
		await plugin.setup(built.ctx as unknown as never);
		const bridge = readBridge();
		const answer = await bridge!.route({ chainId: "switchback/auto", sessionKey: "ses-e", reason: "user" });
		expect(answer).toMatchObject({ status: "config-invalid" });
	});

	it("resolves the chain's entries for the cascade", async () => {
		await setup();
		const bridge = readBridge();
		const entries = await bridge!.entries("switchback/auto");
		expect(entries.map((entry) => entry.modelId)).toEqual(["alpha-corp/alpha-model", "beta-corp/beta-model"]);
		for (const entry of entries) {
			expect(entry.providerModule).toContain("@opencode/ai/providers/");
			expect(entry.contextWindow).toBe(128_000);
		}
	});
});

describe("config file (one shared file, never pi's)", () => {
	it("reads the shared ~/.config/switchback file, not pi's agent dir", async () => {
		// A pi-only copy in the agent dir must be invisible to OpenCode. It names a
		// model the catalog does not contain, so honouring it would make the chain
		// unresolvable rather than merely different.
		writeFileSync(
			join(agentDir, "switchback.yaml"),
			'# pi-specific copy\nmodels:\n  - id: switchback/auto\n    name: pi only\n    fallbacks: ["ghost-corp/ghost-model"]\n',
		);
		const synthetic = vi.fn();
		const { editors } = await setup(CATALOG, synthetic);
		// `setup()` writes the shared file; the published chain came from it.
		const record = editors[0]!.add.mock.calls[0]![0] as { models: { name: string }[] };
		expect(record.models[0]?.name).toBe("Auto (Switchback)");
		const bridge = readBridge()!;
		const answer = await bridge.route({ chainId: "switchback/auto", sessionKey: "ses-shared", reason: "user" });
		expect(answer).toMatchObject({ status: "ok", current: "alpha-corp/alpha-model" });
	});

	it("does not fall back to pi's agent dir when no shared file exists", async () => {
		// The regression: this file used to BE the config. Now it is inert, so a
		// machine with no shared file gets DEFAULT_CONFIG (no fallbacks) instead of
		// silently running pi's chains.
		writeFileSync(
			join(agentDir, "switchback.yaml"),
			'# pi-specific copy\nmodels:\n  - id: switchback/auto\n    name: pi only\n    fallbacks: ["alpha-corp/alpha-model"]\n',
		);
		const synthetic = vi.fn();
		// Same as `setup()` but WITHOUT writeConfig(): no shared file exists.
		const built = fakeCtx(CATALOG, synthetic);
		await plugin.setup(built.ctx as unknown as never);
		const record = built.editors[0]!.add.mock.calls[0]![0] as { models: { name: string }[] };
		expect(record.models[0]?.name).toBe("Auto (Switchback)");
		expect(record.models[0]?.name).not.toBe("pi only");
	});
});

describe("commands", () => {
	it("lists every fallback with its resolved state", async () => {
		const synthetic = vi.fn();
		const { commands } = await setup(CATALOG, synthetic);
		const status = commands.get("switchback");
		expect(status).toBeDefined();
		await status!({ sessionID: "ses-f", prompt: { text: "" } });
		const text = notices(synthetic).join("\n");
		expect(text).toContain("switchback/auto");
		expect(text).toContain("alpha-corp/alpha-model: available");
		expect(text).toContain("beta-corp/beta-model: available");
	});

	it("unblocks via /switchback-unblock ALL", async () => {
		const synthetic = vi.fn();
		const { commands } = await setup(CATALOG, synthetic);
		const bridge = readBridge();
		await bridge!.route({
			chainId: "switchback/auto",
			sessionKey: "ses-g",
			reason: "retry",
			failed: { modelId: "alpha-corp/alpha-model", message: QUA_ERR },
		});
		expect(Object.keys(JSON.parse(readFileSync(stateFilePath(), "utf8")))).toContain("alpha-corp/alpha-model");
		const unblock = commands.get("switchback-unblock");
		expect(unblock).toBeDefined();
		await unblock!({ sessionID: "ses-g", prompt: { text: "ALL" } });
		expect(notices(synthetic).some((text) => text.includes("unblocked"))).toBe(true);
		expect(Object.keys(JSON.parse(readFileSync(stateFilePath(), "utf8")))).not.toContain("alpha-corp/alpha-model");
	});
});

describe("reasoning level application", () => {
	it("carries the settled level in providerOptions, and omits it for `off`", () => {
		// The level must ride `providerOptions`, never a message part: a message
		// part is a cache-preserving protocol only some routes accept, and the
		// host strips it for every other route inside its own prepareRequest - a
		// step this delegation bypasses. An unfiltered part made every fallback
		// hop fail while compiling, so the cascade never produced a frame.
		expect(appliedLevel({ messages: [] }, "high", "openai-chat")).toEqual({ reasoningEffort: "high" });
		// `off` means "no reasoning": the request passes through untouched.
		expect(appliedLevel({ messages: [] }, "off", "openai-chat")).toBeUndefined();
	});

	it("keys the level the way the physical protocol decodes it", () => {
		// Chat/responses families read `reasoningEffort`.
		for (const protocol of ["openai-chat", "openai-compatible-chat", "open-responses", "zai-chat", "mistral-chat", "venice-chat"]) {
			expect(appliedLevel({}, "medium", protocol)).toEqual({ reasoningEffort: "medium" });
		}
		// Anthropic-and-friends read `effort`.
		for (const protocol of ["anthropic-messages", "bedrock-converse", "alibaba-messages", "zai-messages"]) {
			expect(appliedLevel({}, "medium", protocol)).toEqual({ effort: "medium" });
		}
	});

	it("preserves providerOptions the host already set", () => {
		const providerOptions = { store: false, reasoningEffort: "minimal" };
		expect(appliedLevel({ providerOptions }, "high", "openai-chat")).toEqual({ store: false, reasoningEffort: "high" });
	});
});

describe("pin and inspection commands", () => {
	it("pin commands need a selected switchback model", async () => {
		const synthetic = vi.fn();
		const { commands } = await setup(CATALOG, synthetic);
		const next = commands.get("switchback-next");
		expect(next).toBeDefined();
		await next!({ sessionID: "ses-h", prompt: { text: "" } });
		expect(
			notices(synthetic).some((text) => text.includes("only applies while a switchback model is selected")),
		).toBe(true);
	});

	it("cycles the pin through (none, ...fallbacks) and clears it again", async () => {
		const synthetic = vi.fn();
		const { commands, selection } = await setup(CATALOG, synthetic);
		selection.set("ses-i", { providerID: "switchback", id: "auto" });
		const next = commands.get("switchback-next")!;
		const pins = () => JSON.parse(readFileSync(pinFilePath(), "utf8")) as Record<string, string | null>;
		await next({ sessionID: "ses-i", prompt: { text: "" } });
		expect(pins()["switchback/auto"]).toBe("alpha-corp/alpha-model");
		await next({ sessionID: "ses-i", prompt: { text: "" } });
		expect(pins()["switchback/auto"]).toBe("beta-corp/beta-model");
		await next({ sessionID: "ses-i", prompt: { text: "" } });
		expect(pins()["switchback/auto"]).toBeUndefined();
	});

	it("pins directly and lists the choices without an argument", async () => {
		const synthetic = vi.fn();
		const { commands, selection } = await setup(CATALOG, synthetic);
		selection.set("ses-j", { providerID: "switchback", id: "auto" });
		const pin = commands.get("switchback-model")!;
		await pin({ sessionID: "ses-j", prompt: { text: "beta-corp/beta-model" } });
		expect(JSON.parse(readFileSync(pinFilePath(), "utf8"))["switchback/auto"]).toBe("beta-corp/beta-model");
		await pin({ sessionID: "ses-j", prompt: { text: "" } });
		expect(notices(synthetic).some((text) => text.includes("current pin"))).toBe(true);
		await pin({ sessionID: "ses-j", prompt: { text: "auto" } });
		expect(JSON.parse(readFileSync(pinFilePath(), "utf8"))["switchback/auto"]).toBeUndefined();
		// A model outside the chain is refused rather than written.
		await pin({ sessionID: "ses-j", prompt: { text: "gamma-corp/gamma-model" } });
		expect(JSON.parse(readFileSync(pinFilePath(), "utf8"))["switchback/auto"]).toBeUndefined();
	});

	it("lists blocks with reset times from the live block map", async () => {
		const synthetic = vi.fn();
		const { commands } = await setup(CATALOG, synthetic);
		const bridge = readBridge()!;
		await bridge.route({
			chainId: "switchback/auto",
			sessionKey: "ses-k",
			reason: "retry",
			failed: { modelId: "alpha-corp/alpha-model", message: QUA_ERR },
		});
		await commands.get("switchback-blocked")!({ sessionID: "ses-k", prompt: { text: "" } });
		const text = notices(synthetic).join("\n");
		expect(text).toContain("alpha-corp/alpha-model");
		expect(text).toMatch(/resets in \d+ min/);
	});
});

describe("conversation-derived routing inputs", () => {
	it("returns to the head of the list after the configured idle time", async () => {
		const synthetic = vi.fn();
		const { history, commands } = await setup(CATALOG, synthetic);
		// `setup()` writes the base config, so the idle policy is added after it (the
		// router re-reads the config on every call).
		writeFileSync(
			join(process.env["SWITCHBACK_CONFIG_DIR"] ?? tmp, "switchback.yaml"),
			readFileSync(join(process.env["SWITCHBACK_CONFIG_DIR"] ?? tmp, "switchback.yaml"), "utf8").replace(
				"    decisionModel: fixture/jev",
				"    decisionModel: fixture/jev\n    idleReset: 30m",
			),
		);
		const bridge = readBridge()!;
		// First request starts at the head; a quota failure moves the session on.
		const first = await bridge.route({ chainId: "switchback/auto", sessionKey: "ses-l", reason: "user" });
		expect(first).toMatchObject({ status: "ok", current: "alpha-corp/alpha-model" });
		const second = await bridge.route({
			chainId: "switchback/auto",
			sessionKey: "ses-l",
			reason: "retry",
			failed: { modelId: "alpha-corp/alpha-model", message: QUA_ERR },
		});
		expect(second).toMatchObject({ status: "ok", current: "beta-corp/beta-model" });
		// A live session stays put: the newest message is seconds old.
		history.set("ses-l", [{ time: { created: Date.now() - 5_000 } }]);
		const live = await bridge.route({ chainId: "switchback/auto", sessionKey: "ses-l", reason: "user" });
		expect(live).toMatchObject({ status: "ok", current: "beta-corp/beta-model" });
		// After 45 minutes idle the cache is cold, so the head is worth preferring
		// again - once its quota block has expired (cleared here to keep the test
		// clock deterministic).
		await commands.get("switchback-unblock")!({ sessionID: "ses-l", prompt: { text: "ALL" } });
		history.set("ses-l", [{ time: { created: Date.now() - 45 * 60_000 } }]);
		const idle = await bridge.route({ chainId: "switchback/auto", sessionKey: "ses-l", reason: "user" });
		expect(idle).toMatchObject({ status: "ok", current: "alpha-corp/alpha-model" });
	});
});

describe("diagnostics stay quiet unless asked", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env["SWITCHBACK_DEBUG"];
	});

	it("writes nothing to stderr for a provider with no stored connection", async () => {
		// The host's integration store is optional, and `opencode.json` keys never
		// create one. Resolving entries therefore has to stay silent: the line this
		// replaced fired once per model per TTL on a perfectly healthy install.
		await setup();
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const entries = await readBridge()!.entries("switchback/auto");
		expect(entries).toHaveLength(2);
		expect(error).not.toHaveBeenCalled();
	});

	it("keeps the failover trace off by default and prints it under `debug:`", async () => {
		// A failed hop is the expected steady state of a cascade, so the stack trace
		// is diagnostics rather than an error: it follows the same switch as the
		// switch notifications, and the notice the cascade emits already tells the
		// user what happened.
		await setup();
		const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(readBridge()!.debug()).toBe(false);
		debugLog("tripwire", new Error("boom"));
		expect(quiet).not.toHaveBeenCalled();

		writeConfig("debug: true\n");
		const loud = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(readBridge()!.debug()).toBe(true);
		debugLog("tripwire", new Error("boom"));
		expect(loud).toHaveBeenCalledTimes(1);
		expect(String(loud.mock.calls[0]![0])).toContain("[switchback] tripwire");
	});

	it("honours SWITCHBACK_DEBUG over the config, as the docs promise", async () => {
		// pi has always read this variable; OpenCode ignored it while the shared
		// documentation promised both hosts honour it.
		await setup();
		expect(readBridge()!.debug()).toBe(false);
		process.env["SWITCHBACK_DEBUG"] = "1";
		expect(readBridge()!.debug()).toBe(true);
		process.env["SWITCHBACK_DEBUG"] = "0";
		expect(readBridge()!.debug()).toBe(false);
	});
});
