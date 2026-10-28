/**
 * The GUI bundle build for OpenCode Desktop.
 *
 * The desktop app loads `./gui-experimental` as ONE prebuilt CommonJS file: it
 * cannot follow a second chunk, and it provides the app's own modules (Solid,
 * `@opencode/plugin/gui`, `@opencode/client`, `effect`, …) at runtime, so a
 * bundled copy of any of them would not share the app's instance. The preset
 * from `@opencode/plugin/gui/vite` encodes exactly those rules:
 *
 *  - compiles Solid JSX,
 *  - emits one CJS file with every dynamic `import()` inlined,
 *  - keeps the app's shared modules external and bundles the rest,
 *  - fails the build on any other `@opencode/*`, `solid-js/*` or `effect/*`
 *    module, which is the mistake that only shows up as a broken window.
 *
 * Run it with `npm run build -w opencode-switchback`; `dist/gui-experimental.cjs`
 * is what `packages/opencode/package.json` points `./gui-experimental` at.
 */

import { defineConfig } from "vite";
import { gui } from "@opencode/plugin/gui/vite";

export default defineConfig({
	plugins: [gui()],
});
