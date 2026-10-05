# ONBOARDING.md

## What this is

`switchback` is a [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
extension that registers a virtual model `switchback/auto` and routes each
request through a user-configured ordered fallback list, classifying provider
errors with a single SystemOne classifier.

## Entry points

- `index.ts` — extension entry; registers the virtual model + six commands.
- `src/routing.ts` — `decide()`, `buildRoute()`.
- `src/classify.ts` — `classifyError()` (classifier-only).
- `src/availability.ts` — `resolveFallbacks()`, `pickNextEffective()`.
- `src/config.ts` — `loadConfig()`, `findModelConfig()` (YAML only).
- `src/state.ts` — `blocks.json` (account-scoped, atomic).
- `src/crashes.ts` — `crashes.json`, Tier 2b annotation cache.
- `src/simulate.ts` — `loadSimulate()`, `simulateRetry()`.
- `switchback.yaml` — shipped 4-provider fallback list.

## Build / test

```bash
npx tsc --noEmit    # type check
npx vitest run      # 108 tests across 6 files
```

## Tools

- **bd / beads** — issue tracking (prefix `switchback`). See
  `.agents/POLICIES.md` for usage and the personal-data scrub gate.
- **codegraph** / **grepai** — code navigation / semantic search
  (if installed; not bundled).
- **pi-intercom** — multi-session coordination in this cwd.

## Commands (in the pi TUI)

- `/switchback` — current model, effective vs greyed entries, active blocks.
- `/switchback-config` — config source + full fallback list.
- `/switchback-blocked` — currently blocked models.
- `/switchback-crashes [n]` — global crash store (default 10).
- `/switchback-annotate <hash> <class> [note]` — Tier 2b cache write.
- `/switchback-simulate <scenario>` — replay a fixture through `decide()`.

## First-time checks

1. `bd list --all` — full tree (single source of truth for the backlog).
2. `npx vitest run` — confirm clean before any change.
3. Read `README.md` — high-level design, coverage matrix, commands.
