# src/core/ — host-agnostic core

## Purpose

The switchback decision logic: classify a failure, then block / advance / stick,
plus the config, store and classifier-transport modules that support it. Every
module here runs against the host boundary declared in `src/core/ports.ts`, not
against pi, so the same core can serve a second host adapter (the plan is
`.agents/plans/opencode-support.md`).

The pi-specific half stays in `src/`: `src/build-route.ts` (pi `ModelRoute`
construction), `src/local-classifier.ts`, the `src/dialogue*.ts` wizard,
`src/model-picker.ts`, `src/secrets.ts` (the Windows DPAPI store) and the
`src/index.ts` barrel.

## Ownership

- `src/core/*.ts`.
- `src/core/ports.ts` is the single home of the host boundary: a port is
  declared there and imported from there.
- The module → path table is `.agents/FILES.md`; the contracts every `src/`
  module shares are `src/AGENTS.md`.

## Local Contracts

- **No host values; host types are on their way out.** A core module may not
  import a host *value*. The one left is `clampThinkingLevel` /
  `getSupportedThinkingLevels` in `src/core/thinking.ts`
  (`switchback-wix.3`). Host *type* imports also remain, in two flavours: the
  `@earendil-works/pi-ai` shapes, and `ModelRouteRequest` from
  `@earendil-works/pi-coding-agent` (`src/core/routing.ts:61`,
  `src/core/dispatch.ts:10`). Restating or depending on them is
  `switchback-wix.4`; until that decision lands, adding a *new* host type to a
  core module is a boundary change, not a detail.
- **Narrow, consumed ports.** A port names the slice the core reads, never the
  whole host object, and arrives with the seam that uses it — no port for a
  boundary nothing implements yet (`src/core/ports.ts` header owns the rule and
  the rationale).
- **Types-only host imports stay install-safe** (bare specifier; `src/AGENTS.md`
  owns the rule, `tests/imports.test.ts` pins it).

## Work Guidance

- Same module budget, seam discipline and barrel discipline as `src/AGENTS.md`.
- A core module that gains a host-side consumer gets exported through the
  `src/index.ts` barrel; a core module that reads a new host ability adds that
  ability to `src/core/ports.ts` in the same change.

## Verification

- `npx tsc --noEmit` and `npx vitest run`.
- A new core module that the root `index.ts` graph does not reach is
  type-checked with the targeted run in `src/AGENTS.md` → Verification.

## Child DOX Index

None — no sub-boundaries under `src/core/`.
