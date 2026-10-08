/**
 * Guard: the `src/index.ts` barrel must resolve.
 *
 * `tsconfig.json` includes only the root `index.ts` graph (see
 * `src/AGENTS.md` -> Verification), so `src/index.ts` is not type-checked by
 * `npx tsc --noEmit` - and no other gate loads it either. That gap is not
 * theoretical: splitting `src/dialogue.ts` moved `describeJev` and the
 * structural UI types to `src/dialogue-ui.ts`, the barrel kept re-exporting
 * them from `./dialogue.ts`, and `tsc --noEmit` stayed green while
 * `npx vitest run` stayed green, because nothing imports the barrel.
 *
 * This test imports it. A re-export that names a symbol its module no longer
 * exports now fails here instead of shipping.
 */

import { describe, expect, it } from "vitest";

describe("src/index.ts barrel", () => {
	it("resolves every re-export", async () => {
		const barrel = await import("../src/index.ts");
		expect(Object.keys(barrel).length).toBeGreaterThan(0);
	});

	it("exposes the documented entry surface", async () => {
		const barrel: Record<string, unknown> = await import("../src/index.ts");
		// One name per seam that has moved at least once, so a future split
		// that forgets the barrel is caught here.
		const expected = [
			"runDialogue", // src/dialogue.ts
			"describeJev", // src/dialogue-ui.ts (moved out of dialogue.ts)
			"layerOptionLabel", // src/dialogue.ts
			"decide", // src/routing.ts
			"observeUnretriedFailure", // src/routing.ts
			"buildRoute", // src/build-route.ts (split out of routing.ts)
			"ConfigInvalidError", // src/build-route.ts
		];
		for (const name of expected) {
			expect(barrel[name], `barrel must export ${name}`).toBeTypeOf("function");
		}
	});
});
