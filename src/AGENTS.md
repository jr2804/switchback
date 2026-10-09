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
  (`<piConfigDir>/switchback/`) and is written atomically by
  `writeFileAtomic` (`src/atomic-write.ts`): a staging path per write —
  `<file>.<pid>.<seq>.tmp`, never a fixed `<file>.tmp` two writers could share —
  then a rename retried with a real backoff, because Windows refuses the rename
  with `EPERM` while another process holds the destination (root AGENTS.md
  project rule 3 owns the location; this owns the write pattern). Every store
  goes through it; a store with its own error vocabulary wraps the failure
  (`CrashError`, `SecretsError`, `ConfigError`). Stores handle their own
  on-disk corruption explicitly (quarantine or refuse, never silent overwrite
  of irreplaceable data).
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
- **Keep a module under ~500 lines of code** (comments and blank lines
  excluded; measure per file, not per file plus its test). A user
  preference carried over from Python/Rust/C practice, where the limit is
  a language-independent readability heuristic rather than a TS idiom.
  When a module exceeds it, look for a **responsibility seam** first —
  `src/routing.ts` split into `decide()` (where to go) and
  `src/build-route.ts` (what that means on the wire) because the two had
  genuinely different reasons to change, then again into `src/failure.ts`
  (what a failure means: the verdict, the block, the crash row) because that
  half had a second caller outside routing — the `agent_end` hook — and its own
  reason to change. Do not split mechanically: moving code to hit a number
  costs a `FILES.md` row, a barrel edit and a verification gap (`tsc` only
  covers the entry graph), and buys nothing if the result still has to be read
  together. A symbol that moves across a seam updates its importers to name the
  module that now owns it; do not leave a pass-through re-export behind
  purely so call sites keep compiling. A helper that both sides of a seam need
  moves to the module that owns its *data* rather than being duplicated or
  creating a third module: the routing split deleted a private `isBlockedNow`
  in favour of `state.ts`'s already-exported `isBlocked`.
  A heavily commented file is not automatically over budget — measure code
  lines, not total lines — but a formatter that reflows dense one-liners can
  push a file over on its own (the `gts` pass took `routing.ts` from 458 to
  605 code lines without adding a single symbol).
  The seam may need a third module to stay acyclic: `src/dialogue.ts` became
  a shell plus `src/dialogue-classifier.ts` (the wizard) plus
  `src/dialogue-ui.ts` (session, screen titles, every prompt, shared
  formatters), because the two halves both needed those primitives and a
  direct import between them would have been a cycle. Check the graph, do not
  assume: `build-route.ts` importing nothing from `routing.ts` is what makes
  pulling the decision types down into it safe.

## Verification

- `npx tsc --noEmit` and `npx vitest run` (root AGENTS.md project rule 9).
- **Graph nuance:** `tsconfig.json` includes only the root `index.ts`
  graph, so a module not (yet) imported from there is NOT type-checked by
  the gate. Until it is wired, check it explicitly with a targeted run
  using the same flags (`npx tsc --noEmit --strict --target ES2022
  --module ESNext --moduleResolution bundler --allowImportingTsExtensions
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes <files>`), and
  say so in the milestone report. `src/index.ts` is outside that graph too,
  which is why `tests/barrel.test.ts` imports it.

## Child DOX Index

None — no sub-boundaries under `src/`.
