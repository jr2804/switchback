# packages/pi — the pi adapter

## Purpose

The pi extension. `packages/pi/index.ts` is the product entry: it registers the
virtual `switchback/<id>` models and the `/switchback*` commands against pi's
`ExtensionAPI`. The rest of the package is what only makes sense inside pi —
dispatch onto pi's `ModelRoute` (`src/build-route.ts`), the local-classifier
registration (`src/local-classifier.ts`), the configuration dialogue
(`src/dialogue.ts`, `src/dialogue-classifier.ts`, `src/dialogue-ui.ts`), the
model picker (`src/model-picker.ts`, pi-tui only), and the credential store
(`src/secrets.ts`).

Routing itself — the decision, the ports, the stores, the classifier, the
thinking-level semantics — is `switchback-core`, resolved as a workspace
dependency. `packages/pi/src/index.ts` is a barrel for tests and downstream
consumers only.

## Ownership

- The module → path table lives in `.agents/FILES.md` (single source of truth; a
  new module gets a row there, per `.agents/MAINTENANCE.md`).
- This doc owns the contracts every module in this package shares. Module-specific
  design lives in each file's header comment (state the design and the why, not a
  changelog).
- `packages/core/AGENTS.md` owns the host-agnostic half, the port boundary and the
  no-host-import rule; root AGENTS.md owns the repo-wide project rules.

## Local Contracts

- **Install-safe imports.** Never value-import a deep subpath of a
  host-provided package (`@earendil-works/pi-ai/...`) — bare specifiers
  only; type-only subpath imports are fine. `tests/imports.test.ts` pins
  this (switchback v1 shipped broken over it).
- **The entry stays at the package root.** The loader contract is
  `pi.extensions: ["./index.ts"]`, and `files: ["index.ts", "src"]` is what npm
  publishes — do not move the entry or widen the publish set to include tests.
  Both install routes depend on it: a repo checkout resolves through the
  root `package.json` `pi` field (`./packages/pi/index.ts`) and the published
  `pi-switchback` package resolves through its own manifest.
- **Account-scoped stores.** Runtime state lives under `switchbackStateDir()`
  (`~/.pi/agent/switchback/` by default, `SWITCHBACK_DIR` overrides) and is
  written atomically by
  `writeFileAtomic` (`switchback-core/atomic-write.ts`): a staging path per write
  — `<file>.<pid>.<seq>.tmp`, never a fixed `<file>.tmp` two writers could share —
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
  through `switchback-core/classify.ts` only; root AGENTS.md project rule 1 is
  the rule, this is the pointer.
- **Barrel discipline.** Changes to `src/index.ts` are export lines and
  type exports unless you own the entry; `index.ts` (registration of
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
  `switchback-core/routing.ts` split into `decide()` (where to go) and
  `packages/pi/src/build-route.ts` (what that means on the wire) because the
  two had genuinely different reasons to change, then again into
  `switchback-core/failure.ts` (what a failure means: the verdict, the block,
  the crash row) because that half had a second caller outside routing — the
  `agent_end` hook — and its own reason to change. The package line is the same
  move one level up: `packages/core` holds what any harness can run, while this
  package keeps pi's dispatch, wizard and credential store. Do not split
  mechanically: moving code to hit a number costs a `FILES.md` row, a barrel
  edit and a verification gap, and buys nothing if the result still has to be
  read together. A symbol that moves across a seam updates its importers to name
  the module that now owns it; do not leave a pass-through re-export behind
  purely so call sites keep compiling. A helper that both sides of a seam need
  moves to the module that owns its *data* rather than being duplicated or
  creating a third module: the routing split deleted a private `isBlockedNow`
  in favour of `switchback-core/state.ts`'s already-exported `isBlocked`.
  A heavily commented file is not automatically over budget — measure code
  lines, not total lines — but a formatter that reflows dense one-liners can
  push a file over on its own (the `gts` pass took `routing.ts` from 458 to
  605 code lines without adding a single symbol).
  The seam may need a third module to stay acyclic: `src/dialogue.ts` became
  a shell plus `src/dialogue-classifier.ts` (the wizard) plus
  `src/dialogue-ui.ts` (session, screen titles, every prompt, shared
  formatters), because the two halves both needed those primitives and a
  direct import between them would have been a cycle. Check the graph, do not
  assume: `src/build-route.ts` importing nothing from `routing.ts` is what makes
  pulling the decision types down into it safe.

## Verification

- `npx tsc --noEmit` and `npx vitest run` (root AGENTS.md project rule 9).
- **Test-file nuance:** `tsconfig.json` includes `packages/**/*.ts`, so the gate
  type-checks every shipped module — but not `tests/`. Keep test files
  type-clean and check them with a targeted run when you touch them
  (`npx tsc --noEmit --strict --target ES2022 --module ESNext
  --moduleResolution bundler --allowImportingTsExtensions
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes <files>`), and say so
  in the milestone report.

## Child DOX Index

None — no sub-boundaries under `packages/pi/src/`. The shared host boundary is
owned one level up by `packages/core/AGENTS.md`.
