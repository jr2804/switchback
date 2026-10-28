/**
 * Tests for the notice channel (`packages/opencode/src/notices.ts`) and the
 * portable RPC definition it feeds (`packages/opencode/src/rpc.ts`).
 *
 * What this suite protects:
 *
 *  - the fallback rule: with no attached client a notice must report "not
 *    published", so the caller keeps using the transcript. A toast-only plugin
 *    would be silent in headless `opencode run`;
 *  - the refcount: several clients may attach (TUI window per session, a GUI
 *    window later), and the transcript fallback only returns once the last one
 *    detaches;
 *  - one broken sink must not throw into a routing decision, and the caller has
 *    to learn that nothing took the notice;
 *  - the RPC definition stays portable JSON Schema with the reserved `rpc.`
 *    error prefix untouched, which `Rpc.define` itself enforces;
 *  - the wire readers: the host types handler inputs and client results as
 *    `unknown` (the schemas are plain JSON Schema), so every field crosses a
 *    runtime boundary. A malformed payload must degrade to an empty menu, never
 *    throw into a routing decision or a dialog.
 *
 * The module under test has no host and no file dependencies, so the suite is
 * hermetic by construction.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
	attachNoticeSink,
	detachNoticeSink,
	noticeSinkCount,
	publishNotice,
	resetNoticeChannel,
	setNoticeChannel,
} from "../packages/opencode/src/notices.ts";
import { NOTICE_VARIANTS, readEdit, readGuideState, readNotice, SwitchbackRpc } from "../packages/opencode/src/rpc.ts";
import type { Notice } from "../packages/opencode/src/rpc.ts";

afterEach(() => {
	resetNoticeChannel();
});

describe("notices: transcript fallback", () => {
	it("reports no delivery when nothing is attached", () => {
		expect(publishNotice({ message: "switched", variant: "info" })).toBe(false);
		expect(noticeSinkCount()).toBe(0);
	});

	it("reports no delivery when a sink count exists but no channel is installed", () => {
		attachNoticeSink();
		expect(publishNotice({ message: "switched", variant: "info" })).toBe(false);
	});

	it("delivers to the installed channel once a client attaches", () => {
		const seen: Notice[] = [];
		setNoticeChannel((notice) => seen.push(notice));
		attachNoticeSink();
		expect(publishNotice({ sessionID: "ses_1", message: "zai -> openrouter", variant: "info" })).toBe(true);
		expect(seen).toEqual([{ sessionID: "ses_1", message: "zai -> openrouter", variant: "info" }]);
	});

	it("omits sessionID when the notice has none", () => {
		const seen: Notice[] = [];
		setNoticeChannel((notice) => seen.push(notice));
		attachNoticeSink();
		publishNotice({ message: "exhausted", variant: "error" });
		expect(seen).toHaveLength(1);
		expect(seen[0]?.sessionID).toBeUndefined();
	});
});

describe("notices: refcount across clients", () => {
	it("counts attachments and never drops below zero", () => {
		expect(attachNoticeSink()).toBe(1);
		expect(attachNoticeSink()).toBe(2);
		expect(detachNoticeSink()).toBe(1);
		expect(detachNoticeSink()).toBe(0);
		expect(detachNoticeSink()).toBe(0);
	});

	it("stops delivering once the last client detaches", () => {
		const seen: Notice[] = [];
		setNoticeChannel((notice) => seen.push(notice));
		attachNoticeSink();
		attachNoticeSink();
		detachNoticeSink();
		expect(publishNotice({ message: "still attached", variant: "info" })).toBe(true);
		detachNoticeSink();
		expect(publishNotice({ message: "nobody listening", variant: "info" })).toBe(false);
		expect(seen.map((notice) => notice.message)).toEqual(["still attached"]);
	});
});

describe("notices: a broken sink cannot fail a decision", () => {
	it("swallows a throwing sink and reports no delivery", () => {
		setNoticeChannel(() => {
			throw new Error("toast renderer gone");
		});
		attachNoticeSink();
		expect(() => publishNotice({ message: "switched", variant: "warning" })).not.toThrow();
		expect(publishNotice({ message: "switched", variant: "warning" })).toBe(false);
	});

	it("keeps the attachment count after a sink throws", () => {
		setNoticeChannel(() => {
			throw new Error("boom");
		});
		attachNoticeSink();
		publishNotice({ message: "switched", variant: "info" });
		expect(noticeSinkCount()).toBe(1);
	});
});

describe("rpc definition", () => {
	it("is named switchback and exposes attach/detach plus the guide methods", () => {
		expect(SwitchbackRpc.id).toBe("switchback");
		expect(Object.keys(SwitchbackRpc.methods).sort()).toEqual(["attach", "config", "detach", "state"]);
	});

	it("declares one notice event with the toast variants", () => {
		expect(Object.keys(SwitchbackRpc.events)).toEqual(["notice"]);
		const schema = SwitchbackRpc.events.notice.schema as {
			properties: { variant: { enum: readonly string[] } };
			required: readonly string[];
		};
		expect(schema.properties.variant.enum).toEqual([...NOTICE_VARIANTS]);
		expect(schema.required).toEqual(["message", "variant"]);
	});

	it("uses only JSON Schema (no Effect or host types leaked into the wire shape)", () => {
		const json = JSON.stringify(SwitchbackRpc);
		expect(json).toContain('"type":"object"');
		expect(json).not.toContain("_tag");
	});
});

describe("rpc readers", () => {
	it("reads a notice and defaults an unknown variant to info", () => {
		expect(readNotice({ message: "switched", variant: "warning", sessionID: "ses_1" })).toEqual({
			message: "switched",
			variant: "warning",
			sessionID: "ses_1",
		});
		expect(readNotice({ message: "switched", variant: "shouty" })).toEqual({
			message: "switched",
			variant: "info",
		});
	});

	it("ignores a payload that is not a notice", () => {
		expect(readNotice(undefined)).toBeUndefined();
		expect(readNotice("switched")).toBeUndefined();
		expect(readNotice({ variant: "info" })).toBeUndefined();
	});

	it("reads an edit result and treats a mangled payload as failed", () => {
		expect(readEdit({ ok: true, text: "switchback: updated" })).toEqual({ ok: true, text: "switchback: updated" });
		// A silent `ok` would make the menu claim a save that never happened.
		expect(readEdit(undefined).ok).toBe(false);
		expect(readEdit({ ok: "yes", text: 7 }).ok).toBe(false);
	});

	it("reads guide state and drops malformed rows instead of trusting them", () => {
		const state = readGuideState({
			chains: [
				{ id: "auto", name: "Automatic", fallbacks: ["zai/glm", "openrouter/qwen"] },
				{ id: "auto", name: "Automatic", fallbacks: ["zai/glm", 3, null] },
				{ name: "no id" },
				"nonsense",
			],
			models: [
				{ address: "zai/glm", name: "GLM", contextWindow: 200_000, ready: true },
				{ address: "openrouter/qwen", name: "Qwen" },
				{ name: "no address" },
			],
			path: "/home/u/.pi/agent/switchback/switchback.yaml",
		});
		expect(state.path).toBe("/home/u/.pi/agent/switchback/switchback.yaml");
		expect(state.chains).toHaveLength(2);
		expect(state.chains[1]).toEqual({ id: "auto", name: "Automatic", fallbacks: ["zai/glm"] });
		expect(state.models).toEqual([
			{ address: "zai/glm", name: "GLM", contextWindow: 200_000, ready: true },
			{ address: "openrouter/qwen", name: "Qwen", ready: false },
		]);
		// An absent payload is an empty menu, not a crash.
		expect(readGuideState(undefined)).toEqual({ chains: [], models: [], path: "" });
	});
});
