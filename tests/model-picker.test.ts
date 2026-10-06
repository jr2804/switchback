/**
 * Tests for the searchable model picker (`src/model-picker.ts`).
 *
 * The component is driven directly: a fake TUI, a pass-through theme and a
 * keybindings stub that mirrors pi's `tui.select.*` actions. That exercises the
 * real key routing and the real `SelectList` filtering without a terminal - the
 * visual result is pi-tui's own component, which is not this module's job to test.
 */

import { describe, expect, it } from "vitest";
import type { Api, Model } from "@earendil-works/pi-ai";
import { buildModelItems, createModelPicker, type PickerColor } from "../src/model-picker.ts";

function model(provider: string, id: string, name: string, contextWindow: number): Model<Api> {
	return { provider, id, name, contextWindow } as unknown as Model<Api>;
}

const MODELS = [
	model("zai", "glm-5.3", "GLM 5.3", 1_000_000),
	model("minimax", "MiniMax-M3", "MiniMax M3", 1_000_000),
	model("opencode-go", "mimo-v2.6-flash", "MiMo 2.6 Flash", 128_000),
];

const theme = { fg: (_color: PickerColor, text: string) => text, bold: (text: string) => text };

/** Mirrors pi's keybinding actions for the keys the picker uses. */
function matches(data: string, action: string): boolean {
	switch (action) {
		case "tui.select.confirm":
			return data === "\r";
		case "tui.select.cancel":
			return data === "\x1b";
		case "tui.select.up":
			return data === "\x1b[A";
		case "tui.select.down":
			return data === "\x1b[B";
		default:
			return false;
	}
}

function makePicker(source: Parameters<typeof createModelPicker>[0]["source"] = { models: MODELS, ready: () => true }) {
	const results: (string | undefined)[] = [];
	const picker = createModelPicker({
		title: "add fallback",
		source,
		tui: { requestRender: () => {} },
		theme,
		keybindings: { matches },
		done: (value) => results.push(value),
	});
	return { picker, results };
}

function type(picker: { handleInput(data: string): void }, text: string): void {
	for (const character of text) picker.handleInput(character);
}

describe("model-picker: items", () => {
	it("lists provider/id, describes each model and marks availability", () => {
		const items = buildModelItems({ models: MODELS, ready: (provider) => provider === "zai", current: ["zai/glm-5.3"] });
		// Credentialed models first, then the rest, each group alphabetical.
		expect(items.map((item) => item.value)).toEqual(["zai/glm-5.3", "minimax/MiniMax-M3", "opencode-go/mimo-v2.6-flash"]);
		expect(items[0]?.label).toBe("zai/glm-5.3");
		expect(items[0]?.description).toBe("GLM 5.3 · 1M context · in the list");		expect(items[1]?.description).toBe("MiniMax M3 · 1M context · no credentials");
		expect(items[2]?.description).toBe("MiMo 2.6 Flash · 128k context · no credentials");
	});
});

describe("model-picker: key routing", () => {
	it("filters as the user types and accepts the highlighted entry on Tab", () => {
		const { picker, results } = makePicker();
		picker.focused = true;
		expect(picker.focused).toBe(true);
		// A middle-of-the-id query must match: `setFilter` alone would not (prefix only).
		type(picker, "glm-5");
		const rendered = picker.render(80).join("\n");
		expect(rendered).toContain("zai/glm-5.3");
		expect(rendered).not.toContain("minimax/MiniMax-M3");
		picker.handleInput("\t");
		expect(results).toEqual(["zai/glm-5.3"]);
	});

	it("matches the display name and description too", () => {
		const { picker, results } = makePicker();
		type(picker, "flash");
		picker.handleInput("\r");
		expect(results).toEqual(["opencode-go/mimo-v2.6-flash"]);
	});

	it("accepts the highlighted entry on Enter when the query is not a model reference", () => {
		const { picker, results } = makePicker();
		type(picker, "glm");
		picker.handleInput("\r");
		expect(results).toEqual(["zai/glm-5.3"]);
	});

	it("lets an exact typed reference win, so a model outside the catalog can be added", () => {
		const { picker, results } = makePicker();
		type(picker, "custom/model-x:q8");
		picker.handleInput("\r");
		expect(results).toEqual(["custom/model-x:q8"]);
	});

	it("cancels on Esc", () => {
		const { picker, results } = makePicker();
		picker.handleInput("\x1b");
		expect(results).toEqual([undefined]);
	});

	it("settles once: a second accept after the first does nothing", () => {
		const { picker, results } = makePicker();
		type(picker, "glm");
		picker.handleInput("\r");
		picker.handleInput("\r");
		expect(results).toEqual(["zai/glm-5.3"]);
	});

	it("moves the highlight with the arrow keys", () => {
		// Every model is ready here, so the order is alphabetical.
		const { picker, results } = makePicker();
		picker.handleInput("\x1b[B");
		picker.handleInput("\r");
		expect(results).toEqual(["opencode-go/mimo-v2.6-flash"]);
	});
});
