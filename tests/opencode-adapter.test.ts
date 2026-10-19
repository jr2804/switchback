/**
 * Tests for the OpenCode adapter (packages/opencode/src/index.ts).
 *
 * The whole retry flow runs through `Plugin.define(...)!.setup()` against a
 * hand-built context double: the adapter consumes @opencode/plugin's surface
 * (session hooks, model catalog, command transform, switchModel, synthetic)
 * structurally, so the fakes here are exact mirrors of those shapes and no
 * test imports the host package.
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
import { SWITCHBACK_DIR_ENV } from "switchback-core/config.ts";

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

/** config in the agent-overlay layer (<agentDir>/switchback.yaml). */
function writeConfig(extra = ""): void {
	writeFileSync(
		join(agentDir, "switchback.yaml"),
		`models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - alpha-corp/alpha-model
      - beta-corp/beta-model
${extra}`,
	);
}

/** Address + connection entry switching the classifier from catalog lookup to a direct endpoint. */
const JEV_BLOCK = `    decisionModel: typesafe/jev-fixture
decisionModels:
  typesafe/jev-fixture:
    baseUrl: http://127.0.0.1:9
    apiKey: test-key-alpha-1
`;

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
	delete process.env.WIX11_CLASSIFIER_KEY;
	rmSync(tmp, { recursive: true, force: true });
});

/** Stand-in for Plugin.Context, narrowed to the pieces this adapter consumes. */
function fakeCtx(catalog: typeof CATALOG, switchModel: ReturnType<typeof vi.fn>, synthetic: ReturnType<typeof vi.fn>) {
	const hooks = new Map<string, (input: unknown) => Promise<void>>();
	const commands = new Map<string, (input: { sessionID: string; prompt: { text: string } }) => Promise<void>>();
	const ctx = {
		session: {
			hook: async (name: string, cb: (input: unknown) => Promise<void>) => {
				hooks.set(name, cb);
			},
			switchModel,
			synthetic,
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
	};
	return { ctx, hooks, commands };
}

async function setup(
	catalog: typeof CATALOG,
	switchModel: ReturnType<typeof vi.fn>,
	synthetic: ReturnType<typeof vi.fn>,
) {
	const built = fakeCtx(catalog, switchModel, synthetic);
	await plugin.setup(built.ctx as unknown as never);
	return built;
}

/** A SessionRetry-shaped payload for alpha failing with QUA_ERR. */
function retryPayload(sessionID: string) {
	return {
		sessionID,
		model: { providerID: "alpha-corp", id: "alpha-model" },
		error: { message: QUA_ERR },
		decision: { retry: true, delay: 0 } as { retry: false } | { retry: true; delay: number },
	};
}

function notices(synthetic: ReturnType<typeof vi.fn>): string[] {
	return synthetic.mock.calls.map((call) => (call[0] as { text: string }).text);
}

describe("retry hook: block + advance", () => {
	it("classifies the failure, blocks the failing model and switches to the next fallback", async () => {
		writeConfig(JEV_BLOCK);
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { hooks } = await setup(CATALOG, switchModel, synthetic);
		const payload = retryPayload("sess-quota");
		await hooks.get("retry")?.(payload);
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toContain("127.0.0.1:9");
		expect((fetchSpy.mock.calls[0]?.[1] as { method?: string } | undefined)?.method).toBe("POST");
		expect(switchModel).toHaveBeenCalledTimes(1);
		expect(switchModel.mock.calls[0]?.[0]).toEqual({
			sessionID: "sess-quota",
			model: { providerID: "beta-corp", id: "beta-model" },
		});
		expect(payload.decision).toEqual({ retry: true, delay: 0 }); // OpenCode's policy stays untouched here.
		const blocks = JSON.parse(readFileSync(join(stateDir, "blocks.json"), "utf8")) as Record<string, number>;
		expect(blocks["alpha-corp/alpha-model"]).toBeGreaterThan(Date.now());
	});

	it("flips retry to false when every remaining fallback is unavailable", async () => {
		writeConfig(JEV_BLOCK);
		// Beta is already blocked: with alpha blocked by this verdict nothing is left.
		writeFileSync(join(stateDir, "blocks.json"), JSON.stringify({ "beta-corp/beta-model": Date.now() + 600_000 }));
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { hooks } = await setup(CATALOG, switchModel, synthetic);
		const payload = retryPayload("sess-exhausted");
		await hooks.get("retry")?.(payload);
		expect(switchModel).not.toHaveBeenCalled();
		expect(payload.decision).toEqual({ retry: false });
		expect(notices(synthetic).some((t) => t.includes("alpha-corp/alpha-model") && t.includes("unavailable"))).toBe(
			true,
		);
	});

	it("leaves a model outside every configured chain untouched, silently", async () => {
		writeConfig(JEV_BLOCK);
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { hooks } = await setup(CATALOG, switchModel, synthetic);
		await hooks.get("retry")?.({
			sessionID: "sess-other",
			model: { providerID: "other-corp", id: "other-model" },
			error: { message: QUA_ERR },
			decision: { retry: true, delay: 0 },
		});
		expect(switchModel).not.toHaveBeenCalled();
		expect(synthetic).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(existsSync(join(stateDir, "blocks.json"))).toBe(false);
	});
});

describe("retry hook: without a real verdict", () => {
	it("no classifier configured: no block, no switch, the sighting is recorded", async () => {
		writeConfig(); // No jev block: classifyError hits the not-configured close.
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { hooks } = await setup(CATALOG, switchModel, synthetic);
		const payload = retryPayload("sess-blind");
		await hooks.get("retry")?.(payload);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(switchModel).not.toHaveBeenCalled();
		expect(payload.decision).toEqual({ retry: true, delay: 0 });
		expect(existsSync(join(stateDir, "blocks.json"))).toBe(false);
		const crashed = readFileSync(join(stateDir, "crashes.json"), "utf8");
		expect(crashed).toContain("blind-cycle");
		expect(notices(synthetic).some((t) => t.includes("no classifier decision"))).toBe(true);
	});

	it("an empty provider message short-circuits the hook entirely", async () => {
		writeConfig(JEV_BLOCK);
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { hooks } = await setup(CATALOG, switchModel, synthetic);
		await hooks.get("retry")?.({
			sessionID: "sess-empty",
			model: { providerID: "alpha-corp", id: "alpha-model" },
			error: { message: "   " },
			decision: { retry: true, delay: 0 },
		});
		expect(switchModel).not.toHaveBeenCalled();
		expect(synthetic).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
	});
});

describe("retry hook: secret refs", () => {
	/** Same classifier endpoint as JEV_BLOCK but with the key behind a secret: ref. */
	const SECRET_JEV_BLOCK = `    decisionModel: typesafe/jev-fixture
decisionModels:
  typesafe/jev-fixture:
    baseUrl: http://127.0.0.1:9
    apiKey: secret:WIX11_CLASSIFIER_KEY
`;

	it("resolves secret: refs against the environment", async () => {
		writeConfig(SECRET_JEV_BLOCK);
		process.env.WIX11_CLASSIFIER_KEY = "env-resolved-key-7";
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { hooks } = await setup(CATALOG, switchModel, synthetic);
		await hooks.get("retry")?.(retryPayload("sess-secret"));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer env-resolved-key-7");
		expect(switchModel).toHaveBeenCalledTimes(1); // the resolved classifier produced its verdict
	});

	it("an unresolvable secret ref disables the attempt visibly, nothing else runs", async () => {
		writeConfig(SECRET_JEV_BLOCK);
		delete process.env.WIX11_CLASSIFIER_KEY;
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { hooks } = await setup(CATALOG, switchModel, synthetic);
		const payload = retryPayload("sess-secret-missing");
		await hooks.get("retry")?.(payload);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(switchModel).not.toHaveBeenCalled();
		expect(payload.decision).toEqual({ retry: true, delay: 0 }); // OpenCode's policy untouched
		expect(notices(synthetic).some((t) => t.includes("config problem") && t.includes("does not resolve"))).toBe(
			true,
		);
	});
});

describe("models disabled by hand", () => {
	it("/switchback-disable writes the state file and confirms", async () => {
		writeConfig(JEV_BLOCK);
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { commands } = await setup(CATALOG, switchModel, synthetic);
		await commands.get("switchback-disable")?.({
			sessionID: "sess-disable",
			prompt: { text: "beta-corp/beta-model" },
		});
		const disabled = JSON.parse(readFileSync(join(stateDir, "disabled.json"), "utf8")) as Record<string, number>;
		expect(Object.keys(disabled)).toEqual(["beta-corp/beta-model"]);
		expect(notices(synthetic).join("\n")).toContain("disabled beta-corp/beta-model");
	});

	it("/switchback-disable refuses an address no chain lists", async () => {
		writeConfig(JEV_BLOCK);
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { commands } = await setup(CATALOG, switchModel, synthetic);
		await commands.get("switchback-disable")?.({ sessionID: "sess-unknown", prompt: { text: "gamma-corp/gamma" } });
		expect(existsSync(join(stateDir, "disabled.json"))).toBe(false);
		const text = notices(synthetic).join("\n");
		expect(text).toContain("not a configured fallback");
		expect(text).toContain("alpha-corp/alpha-model");
	});

	it("the retry hook never advances onto a disabled model", async () => {
		writeConfig(JEV_BLOCK);
		writeFileSync(join(stateDir, "disabled.json"), JSON.stringify({ "beta-corp/beta-model": Date.now() }));
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { hooks } = await setup(CATALOG, switchModel, synthetic);
		const payload = retryPayload("sess-disabled");
		await hooks.get("retry")?.(payload);
		expect(switchModel).not.toHaveBeenCalled();
		expect(payload.decision).toEqual({ retry: false });
		expect(notices(synthetic).join("\n")).toContain("disabled by hand");
	});

	it("/switchback-enable ALL clears every manual disable", async () => {
		writeConfig(JEV_BLOCK);
		writeFileSync(
			join(stateDir, "disabled.json"),
			JSON.stringify({ "alpha-corp/alpha-model": Date.now(), "beta-corp/beta-model": Date.now() }),
		);
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { commands } = await setup(CATALOG, switchModel, synthetic);
		await commands.get("switchback-enable")?.({ sessionID: "sess-enable", prompt: { text: "ALL" } });
		const disabled = JSON.parse(readFileSync(join(stateDir, "disabled.json"), "utf8")) as Record<string, number>;
		expect(Object.keys(disabled)).toHaveLength(0);
		expect(notices(synthetic).join("\n")).toContain("re-enabled 2 disabled model(s)");
	});

	it("/switchback marks a manually disabled model", async () => {
		writeConfig(JEV_BLOCK);
		writeFileSync(join(stateDir, "disabled.json"), JSON.stringify({ "beta-corp/beta-model": Date.now() }));
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { commands } = await setup(CATALOG, switchModel, synthetic);
		await commands.get("switchback")?.({ sessionID: "sess-status-disabled", prompt: { text: "" } });
		const text = notices(synthetic).join("\n");
		expect(text).toContain("disabled by hand (enable with /switchback-enable)");
		expect(text).toContain("disabled by hand (1): beta-corp/beta-model");
	});
});

describe("commands", () => {
	it("/switchback lists every chain with live block state", async () => {
		writeConfig(JEV_BLOCK);
		writeFileSync(
			join(stateDir, "blocks.json"),
			JSON.stringify({ "alpha-corp/alpha-model": Date.now() + 600_000 }),
		);
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { commands } = await setup(CATALOG, switchModel, synthetic);
		await commands.get("switchback")?.({ sessionID: "sess-status", prompt: { text: "" } });
		const text = notices(synthetic).join("\n");
		expect(text).toContain("alpha-corp/alpha-model");
		expect(text).toContain("beta-corp/beta-model");
	});

	it("/switchback-unblock ALL clears every live block", async () => {
		writeConfig();
		writeFileSync(
			join(stateDir, "blocks.json"),
			JSON.stringify({ "alpha-corp/alpha-model": Date.now() + 600_000 }),
		);
		const switchModel = vi.fn(async (_input: unknown) => undefined);
		const synthetic = vi.fn(async (_input: unknown) => undefined);
		const { commands } = await setup(CATALOG, switchModel, synthetic);
		await commands.get("switchback-unblock")?.({ sessionID: "sess-unblock", prompt: { text: "ALL" } });
		const blocks = JSON.parse(readFileSync(join(stateDir, "blocks.json"), "utf8")) as Record<string, number>;
		expect(Object.keys(blocks)).toHaveLength(0);
		expect(notices(synthetic).join("\n")).toContain("unblocked");
	});
});
