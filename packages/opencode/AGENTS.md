# packages/opencode — the OpenCode adapter

## Purpose

The OpenCode V2 adapter, `opencode-switchback`: provider-architecture routing
with pi-equivalent functionality. A plugin publishes the configured chains as
selector-visible models of a synthetic `switchback` provider
(`ctx.provider.transform`), and a delegating provider-package route
(`src/route.ts`, bridge via `globalThis`) executes every request by dispatching
to the physical model the core router picks — per request, in-flight, the same
`decide()` call pi makes at its virtual-model seam. Failures are classified by
the configured classifier, blocked with the classifier-supplied reset time, and
the cascade advances inside the same request until a model answers; when
nothing effective is left the router reports `exhausted` and OpenCode surfaces
the failure. Commands: `/switchback`, `/switchback-unblock`,
`/switchback-disable`, `/switchback-enable`, `/switchback-next`,
`/switchback-model`, `/switchback-blocked`, `/switchback-crashes`,
`/switchback-annotate`, `/switchback-config` — the same set pi registers.
Design and host-seam findings: `.agents/plans/opencode-support.md`.

### Three entrypoints, one plugin

The package publishes a server half (`src/index.ts`, the default export), a
TUI half (`src/tui.ts`, exported as `./tui`) and a GUI half
(`src/gui.tsx` → the prebuilt `dist/gui-experimental.cjs`, exported as
`./gui-experimental`), the last two only when the host runs that client. The
split is what makes the surfaces pi has actually work:

- **Notices.** A server plugin can only write into the transcript, where a
  mid-turn "switched to X" reads like the model said it. The server half
  publishes every notice on a portable RPC (`src/rpc.ts`, method `attach`); the
  TUI and GUI halves attach and show it as a toast. With nothing attached the
  server keeps the synthetic message, so headless `opencode run` still reports
  switches. `src/notices.ts` owns that refcount.
- **Configuration.** `/switchback-config` has one argument grammar
  (`src/config-command.ts`) and one writer. The TUI's guided menu
  (`src/tui-guide.ts`) is a *client* of that grammar: every screen dispatches
  the verb a typed command would (`raise` → `chain-move <id> <n> <n-1>`), read
  back through the RPC's `state` and `config` methods, so the menu and the
  command cannot drift. Edits are followed by `ctx.provider.reload()` +
  `ctx.model.reload()`, because the selector is rebuilt by the transform. The
  GUI half runs the same `tui-guide.ts` over the desktop app's dialogs
  (`src/gui-support.ts` adapts them), so all three surfaces share one editor.

Config, block state, crash corpus and the configured classifier are shared with
the pi adapter unchanged (`switchback-core` config layers, default state dir,
`SWITCHBACK_DIR` override) — root AGENTS.md project rule 3 owns the location.

## Ownership

- `packages/opencode/src/`: `index.ts` (plugin entry: provider publication,
  RPC registration, commands), `tui.ts` (TUI entry: toast sink + the
  `/switchback-config` slash command), `gui.tsx` (GUI bundle entry: toast sink +
  the same slash command as a desktop command), `gui-support.ts` (the GUI's
  host-free logic: dialog adaptation, variant mapping, attach ordering),
  `tui-guide.ts` (guided menu over the config grammar, shared by both menus),
  `config-command.ts` (the `/switchback-config` grammar and
  its single writer), `rpc.ts` (portable RPC definition + the readers that turn
  `unknown` wire payloads into typed shapes), `notices.ts` (notice channel and
  sink refcount), `fuzzy.ts` (picker filtering), `bridge.ts` (router↔route
  seam, `globalThis` symbol), `router.ts` (core `decide()` wiring, credentials,
  notifications), `route.ts` (delegating route: physical dispatch, failover),
  `catalog.ts` (chain → physical entry resolution). `vite.config.ts` builds the
  GUI bundle.
- This doc owns the adapter's contracts. The decision logic it calls is
  `packages/core` (`packages/core/AGENTS.md`); the module → path table is
  `.agents/FILES.md`; the suites pinning the flow are
  `tests/opencode-adapter.test.ts`, `tests/opencode-config-command.test.ts`,
  `tests/opencode-notices.test.ts`, `tests/opencode-tui.test.ts`,
  `tests/opencode-tui-guide.test.ts`, `tests/opencode-gui.test.ts`.

## Local Contracts

- **OpenCode V2 only.** `https://opencode.ai/v2/docs` is the only valid source;
  the V1 plugin API is a different, incompatible surface (`.agents/POLICIES.md`
  → Reference material).
- **The `retry` session hook cannot route.** It only runs when OpenCode's own
  policy already decided to retry, and OpenCode never retries quota errors —
  the retry-hook design (option B) is superseded. Do not reintroduce turn
  boundary switching as the primary mechanism.
- **`model.request` can only change baseURL/headers** (`session/model-request.ts`),
  so in-flight model choice lives in the provider-package route
  (`package: "opencode-switchback"` on every published catalog model → host
  calls our `model(modelID, settings)` → delegating route).
- **Realm isolation.** The host bundles its own `@opencode/ai` copy; any class
  instance we import (`LanguageModel`, `LLMRequest`) is realm-locked by
  `Schema.declare(v => v instanceof LanguageModel)`. Host-built requests must be
  re-wrapped through `localizeRequest()` before entering our protocol code, and
  the wire request must carry the PHYSICAL model id/provider, never the virtual
  chain id (`localizeRequest` does both). Values and plain objects cross realms
  freely; class identity does not.
- **Structural host shapes only.** The adapter imports nothing from
  `@opencode/client`; host objects are narrowed through local structural
  interfaces (`EditorLike`, `RouteLike`, `PhysicalEntry`). The generated client
  types are not exported by the package's exports map.
- **Reuse, do not fork, the decision logic.** Classification, blocking, block
  state and crash rows come from `switchback-core` (`decide`, `assessFailure`,
  block/disable stores, `recordDecideCrash`); a behaviour that needs a host
  capability becomes a port in `packages/core/src/ports.ts`, never a parallel
  implementation here.
- **No verdict, no fabricated answer.** When the classifier cannot produce a
  decision, the router cycles to the next effective model without writing the
  block map (the universal baseline, root AGENTS.md rule 1); dispatch failures
  that reach the last entry surface to the user.
- **The router's settled reasoning level is applied on the wire.** Core resolves
  the level (`dispatch.ts`); `route.ts` `appliedLevel()` appends it as an
  `effort` content part, because the host only emits `effort` parts for variants
  it recognizes as its own effort names, while switchback's variants are its
  category scale. `off` appends nothing (the provider default).
- **Session state is per-session and process-lifetime.** `router.ts` keys
  `SwitchbackState` by `sessionKey`; a restart re-derives it from disk state and
  the config, as pi does across a fresh branch.
- **Conversation-derived inputs come from `ctx.session.context`.** Message
  timestamps feed the idle reset, and the newest assistant `tokens.input +
  tokens.cache.read` feeds context fit. Both degrade to "unknown" when the read
  fails, so routing never depends on it succeeding.
- **Commands take their argument from `prompt.text`.** `/switchback-model` lists
  its choices when called without an argument; the interactive menus live in the
  TUI half, not in a server command.
- **The TUI and GUI halves own presentation only.** They render toasts and run
  the menu; they never parse `switchback.yaml`, never write it, and never route.
  Every edit travels as layer-1 verb text through the RPC's `config` method, and
  the server's single editor decides whether it lands. A new menu action that
  needs a new verb adds the verb to `config-command.ts` first.
- **The GUI bundle may import only the app's provided modules.** Both processes
  provide `effect`, `@opencode/plugin/gui`, `@opencode/plugin/gui/main`,
  `@opencode/plugin/rpc`, `@opencode/schema/rpc`, `@opencode/client`,
  `@opencode/client/effect`; windows add `solid-js` and
  `@opencode/plugin/gui/{file,review,browser}`; main adds `electron` and Node
  built-ins. Anything else must be bundled, and bundling another `@opencode/*`,
  `solid-js/*` or `effect/*` module fails the build on purpose: a bundled copy
  would not share the app's instance. That is why `rpc.ts` imports
  `@opencode/plugin/rpc` (provided) and not the plugin root (not provided), and
  why nothing under `src/` may import `@opencode/plugin/gui` outside `gui.tsx`.
- **`setup` is synchronous and must not await the server RPC.** The attach
  schedule retries over seconds; a window that blocked on it would delay the
  plugin. Notices that arrive before the attach lands are not lost — they fall
  back to the server's transcript message.
- **The GUI's dialogs differ from the TUI's in three ways**, all handled in
  `gui-support.ts` and none of them by forking the guide: `confirm` takes
  `description` (not `message`) and resolves `false` rather than `undefined`,
  `select` searches natively (so the guide's `search` hook is dropped), and the
  app has no `warning`/`info` toast variant (both map to `default`).
- **The wire is plain JSON Schema, so handlers see `unknown`.** Nothing may cast
  an RPC payload directly: read it through `rpc.ts`'s readers
  (`readNotice`/`readEdit`/`readGuideState`), which drop malformed rows and
  degrade to an empty menu instead of throwing into a routing decision or a
  dialog.
- **Transient budget stays at 0.** A transient cycle pi counts in flight is one
  OpenCode has no notion of here; do not thread host attempt counts into core
  without reopening that seam.
- **State goes through the core stores** (`blocks.json`, `crashes.json`,
  `disabled.json`) with the account-scoped default directory + `SWITCHBACK_DIR`
  override; the core owns format, migration and atomic writes.
- **`secret:` refs resolve from the environment.** OpenCode's credential API
  activates stored profiles but never returns key material, so config secrets
  use the env-backed `SecretResolver`; an unresolvable ref is a visible config
  problem (core `ConfigError`). Physical-model credentials (API keys for the
  dispatch itself) are looked up live through `ctx.integration.connection` in
  `router.ts`.
- **Catalog ids are provider-relative.** Published models carry the chain id
  minus the `switchback/` prefix (`switchback/auto` → `auto`); the host scopes
  them by the provider. Every published model needs `cost: []`,
  `time: {released: 0}`, `status: "active"` or the host's strict `Model.Info`
  validation rejects the catalog.

## Work Guidance

- Verify an API against the installed package's own declarations
  (`node_modules/@opencode/plugin/dist/promise/*.d.ts`, `@opencode/ai/dist/**`)
  before using it; record what the docs leave unstated in the plan file, not
  this contract.
- **Bucket B is no longer host-blocked; it is covered by the TUI and GUI
  halves.** A server plugin has no UI surface, but `@opencode/plugin/tui` does
  (`ui.toast`, `ui.dialog`, `keymap.layer` with `slash`) and
  `@opencode/plugin/gui` does (`toast.show`, `dialogs.*`, `Command` with
  `slash`), so ephemeral toasts and the interactive config dialogue ship there.
  `credential` is still `Pick<CredentialApi,"activate">` (no write, no
  read-back), so `secret:` refs stay env-backed.
- Build the GUI bundle with `npm run build -w opencode-switchback` (also wired
  as `prepack`); verify it with `npm pack --dry-run -w opencode-switchback`,
  which must list `dist/gui-experimental.cjs`. The root `.gitignore` ignores
  `dist/`, so the bundle is never committed — it is rebuilt on publish.
- Every host call the adapter makes belongs in this package; every decision it
  makes belongs in `packages/core`. A new host capability needs both an
  integration here and a `fakeCtx` row in `tests/opencode-adapter.test.ts` or
  it is untested.
- The chain config is read once at plugin setup and on provider reload; the
  catalog and block state are read per decision — do not snapshot either in
  shared state.
- Iterating against the installed host: copy `src/*.ts` into the cache package
  directory npm created for the globally installed `opencode-switchback`, then
  `opencode service restart` (the service keeps old modules until restarted;
  `--standalone` runs have a startup race where the session drain precedes the
  plugin's provider transform).

## Verification

- `npx tsc --noEmit` (root graph covers `packages/**`, including `.tsx`) and
  `npx vitest run`; the adapter suites are `tests/opencode-adapter.test.ts`
  (hermetic via `SWITCHBACK_DIR`/`PI_CODING_AGENT_DIR`/`USERPROFILE`, classifier
  served by a stubbed `globalThis.fetch`), `tests/opencode-config-command.test.ts`,
  `tests/opencode-notices.test.ts`, `tests/opencode-tui.test.ts`,
  `tests/opencode-tui-guide.test.ts` (drive `setup` with a structural fake TUI
  context and a scripted dialog: no renderer, no host) and
  `tests/opencode-gui.test.ts` (drives the GUI logic through `gui-support.ts`,
  since the bundle itself needs Solid and a window).
- The TUI entrypoint must not import `@opencode/plugin/tui`'s root: it pulls the
  Solid renderer into every importer's graph. `tui.ts` imports types plus
  `rpc.ts` only, and re-implements `Plugin.define` as the identity function it
  is. Same rule for the GUI: `gui-support.ts` imports host types only as types,
  so the test graph never reaches `@opencode/plugin/gui`.
- `npx eslint .` covers `gui.tsx` because `tsconfig.eslint.json` includes
  `packages/**/*.tsx`; the built bundle under `dist/` is ignored by
  `eslint.config.js`. Add a new `.tsx` entry only if it joins that include.
- Nothing here is loaded by the pi extension: the extension's loader contract
  (`pi.extensions`) and `packages/pi` are unaffected by changes in this package.
- A behaviour claim about OpenCode that has not been run in OpenCode is a
  hypothesis. Say which half is verified and which is not.

## Child DOX Index

None — no sub-boundaries under `packages/opencode/src/`.
