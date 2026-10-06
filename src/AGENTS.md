# src/ — extension core

## Purpose

Library modules behind the switchback pi extension. The entry (repo-root
`index.ts`) imports them directly; `src/index.ts` is a barrel for tests and
downstream consumers only.

## Ownership

- The module → path table lives in `.agents/FILES.md` (single source of
  truth; a new module gets a row there, per `.agents/MAINTENANCE.md`).
- This doc owns the contracts every `src/` module shares. Module-specific
  design lives in each file's header comment (state the design and the why,
  not a changelog).

## Local Contracts

- **Install-safe imports.** Never value-import a deep subpath of a
  host-provided package (`@earendil-works/pi-ai/...`) — bare specifiers
  only; type-only subpath imports are fine. `tests/imports.test.ts` pins
  this (switchback v1 shipped broken over it).
- **Account-scoped stores.** Runtime state lives under `piSwitchbackDir()`
  (`<piConfigDir>/switchback/`) and is written atomically — tmp + rename,
  the `state.ts` pattern (root AGENTS.md project rule 3 owns the location;
  this owns the write pattern). Stores handle their own on-disk corruption
  explicitly (quarantine or refuse, never silent overwrite of
  irreplaceable data).
- **Typed errors at public boundaries** — `ConfigError`, `CrashError`,
  `SecretsError`, `SimulateError`: stable `name`, message prefix, `cause`
  retained. No bare `throw new Error` from an exported function.
- **Classifier path is not ours to extend.** Message-derived decisions go
  through `src/classify.ts` only; root AGENTS.md project rule 1 is the
  rule, this is the pointer.
- **Barrel discipline.** Changes to `src/index.ts` are export lines and
  type exports unless you own the entry; root `index.ts` (registration of
  the virtual model + commands) is off-limits without its owner.

## Work Guidance

- Match sibling style: tabs, concrete types under `strict` +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
  (`.agents/POLICIES.md`), no `any`, no duck-typed guards, no swallowed
  catches — fail with a typed error instead (`.agents/POLICIES.md` →
  Checklist).
- A module that gains consumers gets a barrel export; a module that
  carries user-visible state gets a docs section where that state is
  documented (`docs/configuration.md`).

## Verification

- `npx tsc --noEmit` and `npx vitest run` (root AGENTS.md project rule 8).
- **Graph nuance:** `tsconfig.json` includes only the root `index.ts`
  graph, so a module not (yet) imported from there is NOT type-checked by
  the gate. Until it is wired, check it explicitly with a targeted run
  using the same flags (`npx tsc --noEmit --strict --target ES2022
  --module ESNext --moduleResolution bundler --allowImportingTsExtensions
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes <files>`), and
  say so in the milestone report.

## Child DOX Index

None — no sub-boundaries under `src/`.
