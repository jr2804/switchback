/**
 * Searchable model picker for the config dialogue.
 *
 * `/switchback-config` needs to add physical models to a fallback list, and
 * typing `provider/id` from memory is the wrong shape for that: the catalog
 * knows the ids, so the user should pick from it - the way `/model` does.
 *
 * pi's built-in `ctx.ui.select` is a plain list (no filtering), and pi's own
 * `/model` selector component is internal. What pi *does* expose to extensions
 * is the TUI toolkit it builds those screens from
 * (`@earendil-works/pi-tui`, aliased by the extension loader), and its own
 * bundled extensions assemble searchable pickers from it: an `Input` for the
 * query, a `SelectList` whose `setFilter()` does the fuzzy matching, and
 * `keybindings.matches(data, "tui.select.*")` to route navigation keys. This
 * module follows that pattern exactly:
 *
 *   type to filter (fuzzy, matches provider and id) · ↑/↓ move · Tab or Enter
 *   accept · Esc cancel
 *
 * Enter accepts the highlighted entry; if what was typed already looks like an
 * exact `provider/id` (including an `:tag` suffix, as local runtimes use), the
 * typed value wins - that is the escape hatch for a model the catalog does not
 * list. Everything the picker returns is still validated by the loader at save
 * time, so this module owns presentation only.
 *
 * Availability is shown, never enforced: every chat model is offered, with
 * "no credentials" marked for providers that are not authenticated yet (pi would
 * grey such a model out at route time anyway) and "in the list" for entries the
 * fallback list already carries.
 */

import { Container, fuzzyFilter, Input, SelectList, Spacer, Text, Key, matchesKey } from "@earendil-works/pi-tui";
import type { SelectItem, SelectListTheme } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";

/** How many entries the picker shows at once. */
export const MODEL_PICKER_MAX_VISIBLE = 12;

/** The theme colours the picker uses (a subset of pi's theme tokens). */
export type PickerColor = "accent" | "muted" | "dim" | "warning" | "text";

/** The theme surface the picker needs; pi's real theme satisfies it. */
export interface PickerTheme {
	fg(color: PickerColor, text: string): string;
	bold(text: string): string;
}

/** The TUI surface the picker needs. */
export interface PickerTui {
	requestRender(): void;
}

/** The keybinding surface the picker needs; pi's KeybindingsManager satisfies it. */
export interface PickerKeybindings {
	matches(data: string, action: string): boolean;
}

export interface ModelPickerSource {
	/** Every chat model to offer (the dialogue passes the registry's chat models). */
	models: readonly Model<Api>[];
	/** Whether a provider currently has working credentials (shown, not enforced). */
	ready: (provider: string) => boolean;
	/** `provider/id` values already present in the list being edited. */
	current?: readonly string[];
}

/** Compact context-window label ("1M", "128k"). */
function contextLabel(contextWindow: number | undefined): string | undefined {
	if (contextWindow === undefined || contextWindow <= 0) return undefined;
	if (contextWindow >= 1_000_000) {
		const millions = contextWindow / 1_000_000;
		const text = millions >= 10 ? millions.toFixed(0) : millions.toFixed(1);
		return `${text.replace(/\.0$/u, "")}M`;
	}
	if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}k`;
	return String(contextWindow);
}

/**
 * The picker's entries: credentialed models first (alphabetically by
 * `provider/id`), then the rest, each described by display name, context window
 * and status. Ordering is presentation only - the fuzzy filter reorders by match
 * quality as soon as the user types.
 */
export function buildModelItems(source: ModelPickerSource): SelectItem[] {
	const current = new Set(source.current ?? []);
	const entries = source.models.map((model) => ({
		value: `${model.provider}/${model.id}`,
		label: `${model.provider}/${model.id}`,
		ready: source.ready(model.provider),
		description: [
			model.name,
			contextLabel(model.contextWindow) === undefined
				? undefined
				: `${contextLabel(model.contextWindow)} context`,
			source.ready(model.provider) ? undefined : "no credentials",
			current.has(`${model.provider}/${model.id}`) ? "in the list" : undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join(" · "),
	}));
	entries.sort((a, b) => (a.ready === b.ready ? a.value.localeCompare(b.value) : a.ready ? -1 : 1));
	return entries.map(({ value, label, description }) => ({ value, label, description }));
}

/** SelectList theme built from pi's theme tokens (pi's bundled extensions do the same). */
function selectTheme(theme: PickerTheme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

/** `provider/id`, optionally with a local-runtime `:tag` suffix. */
const EXACT_MODEL_REFERENCE = /^[^/\s]+\/[^:\s]+(?::[^\s:]+)?$/u;

export interface ModelPickerOptions {
	title: string;
	source: ModelPickerSource;
	tui: PickerTui;
	theme: PickerTheme;
	keybindings: PickerKeybindings;
	/** Called with the chosen `provider/id`, or undefined when cancelled. */
	done: (value: string | undefined) => void;
}

/**
 * Build the picker component. The returned component takes keyboard focus; the
 * text box filters the list, navigation keys drive the list, Tab and Enter
 * accept, Esc cancels.
 */
export function createModelPicker(opts: ModelPickerOptions): Container & { focused: boolean } {
	const { tui, theme, keybindings, done } = opts;
	const allItems = buildModelItems(opts.source);
	const input = new Input({ placeholder: "type to search models (provider/model)" });
	/** Holds the current list so filtering can rebuild it (SelectList has no setItems). */
	const listHolder = new Container();
	let settled = false;
	const finish = (value: string | undefined): void => {
		if (settled) return;
		settled = true;
		done(value);
	};
	let list = buildList(allItems);

	function buildList(items: readonly SelectItem[]): SelectList {
		const next = new SelectList([...items], MODEL_PICKER_MAX_VISIBLE, selectTheme(theme));
		next.onSelect = (item) => finish(item.value);
		next.onCancel = () => finish(undefined);
		return next;
	}

	/**
	 * Filter the catalog. `SelectList.setFilter` only matches a prefix of the
	 * value, which is not the `/model` experience ("glm" has to find
	 * `zai/glm-5.3`), so the list is rebuilt from a fuzzy match over the label and
	 * the description - provider, model id and display name all match.
	 */
	function applyFilter(query: string): void {
		const trimmed = query.trim();
		const items =
			trimmed.length === 0
				? allItems
				: fuzzyFilter([...allItems], trimmed, (item) => `${item.label} ${item.description ?? ""}`);
		list = buildList(items);
		listHolder.clear();
		listHolder.addChild(list);
	}

	class Picker extends Container {
		private focusedState = false;

		constructor() {
			super();
			this.addChild(new Text(theme.fg("accent", theme.bold(opts.title)), 1, 0));
			this.addChild(input);
			this.addChild(new Spacer(1));
			listHolder.addChild(list);
			this.addChild(listHolder);
			this.addChild(new Spacer(1));
			this.addChild(
				new Text(theme.fg("dim", "type to filter · ↑/↓ move · Tab or Enter accept · Esc cancel"), 1, 0),
			);
		}

		get focused(): boolean {
			return this.focusedState;
		}

		set focused(value: boolean) {
			this.focusedState = value;
			input.focused = value;
		}

		handleInput(data: string): void {
			if (keybindings.matches(data, "tui.select.cancel")) {
				finish(undefined);
				return;
			}
			if (
				keybindings.matches(data, "tui.select.up") ||
				keybindings.matches(data, "tui.select.down") ||
				keybindings.matches(data, "tui.select.pageUp") ||
				keybindings.matches(data, "tui.select.pageDown")
			) {
				list.handleInput(data);
				tui.requestRender();
				return;
			}
			if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.tab)) {
				const typed = input.getValue().trim();
				// An exact-looking reference wins over the highlight: it is how a
				// model that the catalog does not list gets added.
				const value = EXACT_MODEL_REFERENCE.test(typed) ? typed : list.getSelectedItem()?.value;
				if (value !== undefined) finish(value);
				return;
			}
			input.handleInput(data);
			applyFilter(input.getValue());
			tui.requestRender();
		}
	}

	return new Picker();
}
