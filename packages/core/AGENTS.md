# packages/core — host-agnostic core

## Purpose

The switchback decision logic: classify a failure, then block / advance / stick,
plus the config, store and classifier-transport modules that support it. Every
module here runs against the host boundary declared in `src/ports.ts`, not
against a host SDK, so the same core serves the pi adapter (`packages/pi`) and
the OpenCode adapter (`packages/opencode`; the plan is
`.agents/plans/opencode-support.md`).

The pi-specific half lives in `packages/pi`: `src/build-route.ts` (pi
`ModelRoute` construction), `src/local-classifier.ts`, the `src/dialogue*.ts`
wizard, `src/model-picker.ts`, `src/secrets.ts` (the Windows DPAPI store) and
the `src/index.ts` barrel. The OpenCode adapter lives in `packages/opencode`.

## Ownership

- `packages/core/src/*.ts`.
- `src/ports.ts` is the single home of the host boundary: a port is
  declared there and imported from there.
- The module → path table is `.agents/FILES.md`; the contracts every module in
  `packages/pi` shares are `packages/pi/AGENTS.md`.

## Local Contracts

- **No host values; host types are type-only, by decision (`switchback-wix.4`).**
  A core module may not import a host *value* — `rg` for value imports of
  `@earendil-works/pi-ai` / `@earendil-works/pi-coding-agent` under `src/` and
  you should find none (`tests/thinking.test.ts` proves the thinking port keeps
  it that way). Host *type* imports stay, in three flavours, all `import type`:
  the `@earendil-works/pi-ai` shapes (message/stop-reason/classifier result
  vocabulary), `ModelRouteRequest` from `@earendil-works/pi-coding-agent`
  (`src/routing.ts:61`, `src/dispatch.ts:10`) — pi's per-request router input —
  and the `ThinkingSupportPort` mapping baked into `packages/pi/src/thinking-support.ts`
  (`switchback-wix.3`). The recorded tradeoff: `import type` erases at runtime,
  so a consumer type-checking core sources needs both packages' types
  resolvable — they are optional peers + devDependencies of `switchback-core`.
  Hand-mirroring those shapes into core-owned types was considered and deferred
  (drift risk over packaging weight). Adding a *new* host type to a core module is
  still a boundary change, not a detail.
- **Exactly one config file** (`switchback-wix.12`, user decision m08294).
  `loadConfig(secrets?)` reads `configFilePath()` =
  `~/.config/switchback/switchback.yaml` (`SWITCHBACK_CONFIG_DIR` relocates the
  directory). There are no layers, no aggregation, and no host or project
  candidate: `~/.pi/agent/switchback.yaml` and `<cwd>/.pi/switchback.yaml` are
  ignored even when present. Do not reintroduce either — the hosts do not share
  a model catalog, so divergent copies leave one host with dead fallbacks. State
  (`switchbackStateDir()`) is separate and still lives under `piConfigDir()`.
- **Narrow, consumed ports.** A port names the slice the core reads, never the
  whole host object, and arrives with the seam that uses it — no port for a
  boundary nothing implements yet (`src/ports.ts` header owns the rule and
  the rationale).
- **Types-only host imports stay install-safe** (bare specifier;
  `packages/pi/AGENTS.md` owns the rule, `tests/imports.test.ts` pins it).
- **Publishable shape.** npm publishes `files: ["src"]` with
  `exports: {".": "./src/index.ts", "./*": "./src/*"}` — type-stripped TypeScript
  authored for a host loader. Do not add a build step, a `dist/` layout or a
  file outside `src/` to the published set without changing that contract on
  purpose (`docs/versioning.md` → Publishing).
- **Runtime dependencies are decisions, not conveniences.** `switchback-core`
  carries exactly two: `yaml` (the config format) and `@typesafe-ai/sdk` (the
  SystemOne wire call — URL building, auth, retries, abort; adopted by the
  user's directive (`switchback-v9z`), replacing the hand-rolled transport).
  Switchback still owns answer validation (`src/systemone.ts` `parseAnswers`):
  the SDK types the reply but does not runtime-validate it. A new runtime
  dependency needs a recorded reason of that shape, not "handy".

## Work Guidance

- Same module budget, seam discipline and barrel discipline as
  `packages/pi/AGENTS.md`.
- A core module that gains a host-side consumer gets exported through this
  package's `src/index.ts` barrel; a core module that reads a new host ability
  adds that ability to `src/ports.ts` in the same change.

## Verification

- `npx tsc --noEmit` and `npx vitest run`.

## Child DOX Index

None — no sub-boundaries under `packages/core/src/`.
