/**
 * Subsequence "fuzzy" matching for the model picker.
 *
 * pi's picker reuses `@earendil-works/pi-tui`'s `fuzzyFilter`; OpenCode's TUI
 * exposes only a plain `DialogSelect.search` callback, so the match has to live
 * here. The behaviour that matters for this picker is narrow and worth stating
 * precisely, because a surprising match order is the difference between a
 * usable picker and a list the user scrolls:
 *
 *  - every character of the query must appear in the candidate, in order, but
 *    not necessarily adjacently ("zglm" matches "zai/glm-5.3-flash");
 *  - matching is case-insensitive;
 *  - a candidate that *starts* with the query ranks above one that merely
 *    contains it, and contiguous runs rank above scattered ones, so typing
 *    "glm" puts `zai/glm-*` above `openrouter/qwen3.8-flash-glm`;
 *  - an empty query matches everything with score 0, in the caller's order;
 *  - `null` means "no match" - callers filter on it.
 *
 * Deliberately absent: any notion of "did you mean", provider weighting, or
 * recency. The picker shows what the catalog has, and the ordering rule above
 * is the whole contract (`tests/opencode-tui-setup.test.ts` pins it).
 */

/** Score one contiguous run of matched characters, longer runs worth more. */
function runBonus(runLength: number): number {
	return runLength > 1 ? runLength * runLength : 0;
}

/**
 * Score `candidate` against `query`, or `null` when the query is not a
 * subsequence of the candidate. Higher is better; the score is only meaningful
 * relative to other candidates for the same query.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
	const needle = query.trim().toLowerCase();
	if (needle.length === 0) return 0;
	const haystack = candidate.toLowerCase();
	if (needle.length > haystack.length) return null;

	let score = 0;
	let hayIndex = 0;
	let runLength = 0;
	for (const char of needle) {
		const found = haystack.indexOf(char, hayIndex);
		if (found === -1) return null;
		if (found === hayIndex && hayIndex > 0) {
			// Adjacent to the previous match: a contiguous run.
			runLength += 1;
			score += 6;
		} else {
			score += runBonus(runLength);
			runLength = 1;
			// A word boundary (start, separator, or camel hump) is a cheap win.
			const previous = haystack[found - 1];
			score += previous === undefined || previous === "/" || previous === "-" || previous === "." ? 4 : 0;
		}
		hayIndex = found + 1;
	}
	score += runBonus(runLength);

	// A prefix match beats everything else, then position: earlier is better.
	if (haystack.startsWith(needle)) return score + 100;
	const first = haystack.indexOf(needle);
	if (first >= 0) return score + 50 - Math.min(first, 40);
	return score - Math.min(haystack.length, 80) / 80;
}

/** One labelled candidate: `value` is what a picker returns, `text` is what the user reads. */
export interface FuzzyItem<Value> {
	readonly value: Value;
	readonly text: string;
}

/**
 * Filter and rank `items` by `query`. Matching covers the label and any extra
 * text the caller attaches (a description, an alias), but ranking uses the best
 * score across all of them so "glm" finds a model whose *description* mentions
 * it without pushing it above a real label match.
 *
 * Ties keep the caller's original order (`Array.prototype.sort` is stable),
 * which is what makes an empty query show the catalog exactly as listed.
 */
export function fuzzyFilter<Value>(
	items: readonly FuzzyItem<Value>[],
	query: string,
	extra?: (item: FuzzyItem<Value>) => readonly string[],
): FuzzyItem<Value>[] {
	if (query.trim().length === 0) return [...items];
	const scored: { item: FuzzyItem<Value>; score: number; index: number }[] = [];
	items.forEach((item, index) => {
		const candidates = [item.text, ...(extra?.(item) ?? [])];
		let best: number | null = null;
		for (const candidate of candidates) {
			const score = fuzzyScore(query, candidate);
			if (score === null) continue;
			if (best === null || score > best) best = score;
		}
		if (best !== null) scored.push({ item, score: best, index });
	});
	scored.sort((left, right) => (right.score === left.score ? left.index - right.index : right.score - left.score));
	return scored.map((entry) => entry.item);
}
