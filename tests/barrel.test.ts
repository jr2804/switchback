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

import { beforeAll, describe, expect, it } from "vitest";

/** The barrel exports types as well as values, so it is typed loosely on purpose. */
type Barrel = Record<string, unknown>;

describe("src/index.ts barrel", () => {
	let barrel: Barrel;

	// Loading the barrel pulls in every src/ module, which can exceed vitest's
	// 5s default test timeout when 19 files run in parallel. Import once, here.
	beforeAll(async () => {
		barrel = await import("../src/index.ts");
	}, 30_000);

	it("resolves every re-export", () => {
		expect(Object.keys(barrel).length).toBeGreaterThan(0);
	});

	it("exposes the documented entry surface", () => {
		// One name per seam that has moved at least once, so a future split
		// that forgets the barrel is caught here.
		const expected = [
			"runDialogue", // src/dialogue.ts
			"describeJev", // src/dialogue-ui.ts (moved out of dialogue.ts)
			"layerOptionLabel", // src/dialogue.ts
			"decide", // src/routing.ts
			"observeUnretriedFailure", // src/failure.ts
			"buildRoute", // src/build-route.ts (split out of routing.ts)
			"ConfigInvalidError", // src/build-route.ts
		];
		for (const name of expected) {
			expect(barrel[name], `barrel must export ${name}`).toBeTypeOf("function");
		}
	});
});
