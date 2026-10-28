# ONBOARDING.md

## What this is

`switchback` is a quota-aware model fallback router. `packages/pi/index.ts` is a
[pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension
that registers a virtual model `switchback/auto` and routes each request through
a user-configured ordered fallback list, classifying provider errors with a
single SystemOne classifier. The decision logic is the host-agnostic core
(`packages/core`, published as `switchback-core`); `packages/opencode` is the
OpenCode V2 adapter (provider-architecture routing — see
`.agents/plans/opencode-support.md` and `packages/opencode/AGENTS.md`).

## Entry points

- `packages/pi/index.ts` — pi extension entry; registers one virtual model per config entry + six commands.
- `packages/opencode/src/index.ts` — OpenCode V2 plugin entry (publishes the chains as selector-visible `switchback/*` models; `/switchback` reports the chains).
- `packages/opencode/src/tui.ts` — OpenCode V2 TUI entry (toast notices + the guided `/switchback-config` menu).
- `packages/opencode/src/gui.tsx` — OpenCode Desktop GUI entry (the same toasts and menu over the app's own widgets; bundled to `dist/gui-experimental.cjs`).
- `packages/core/src/ports.ts` — the host boundary: the ports the (host-agnostic) core reads the harness through (`packages/core/AGENTS.md`).
- `packages/core/src/routing.ts` — `decide()`.
- `packages/pi/src/build-route.ts` — `buildRoute()` (decision → pi `ModelRoute`).
- `packages/core/src/classify.ts` — `classifyError()` (classifier-only).
- `packages/core/src/availability.ts` — `resolveFallbacks()`, `pickNextEffective()`.
- `packages/core/src/config.ts` — `loadConfig()`, `findModelConfig()` (YAML only).
- `packages/core/src/state.ts` — `blocks.json` (account-scoped, atomic).
- `packages/core/src/crashes.ts` — `crashes.json`, Tier 2b annotation cache.
- `packages/core/src/simulate.ts` — `loadSimulate()`, `simulateRetry()`.
- `packages/pi/src/secrets.ts` — encrypted API-key store; `createSecretStore()`,
  `secretsFilePath()` (DPAPI via powershell, `secret:<name>` in YAML).
- `switchback.yaml` — shipped 4-provider fallback list.

## Build / test

```bash
npm install         # one lockfile, three workspaces
npx tsc --noEmit    # type check (all of packages/ + root)
npx vitest run      # 309 tests + 11 opt-in across 20 files
```

Run the extension from the repository root with
`pi --extension ./packages/pi/index.ts --model switchback/auto`. Publishing is
tag-driven (see `docs/versioning.md` → Publishing).

## Tools

- **bd / beads** — issue tracking (prefix `switchback`). See
  `.agents/POLICIES.md` for usage and the personal-data scrub gate.
- **codegraph** / **grepai** — code navigation / semantic search
  (if installed; not bundled).
- **pi-intercom** — multi-session coordination in this cwd.

## Commands (in the pi TUI)

- `/switchback` — config source, per-model pin, fallbacks (effective/greyed/blocks), active blocks.
- `/switchback-config` — interactive config editor (virtual models, fallbacks, decision models, API keys, debug).
- `/switchback-next` — cycle the session's virtual-model pin to the next fallback.
- `/switchback-blocked` — currently blocked models.
- `/switchback-crashes [n]` — global crash store (default 10).
- `/switchback-annotate <hash> <class> [note]` — Tier 2b cache write.

## First-time checks

1. `bd list --all` — full tree (single source of truth for the backlog).
2. `npx vitest run` — confirm clean before any change.
3. Read `README.md` — high-level design, coverage matrix, commands.
