# tests/ — vitest suites

## Purpose

`npx vitest run` suites for routing, classification, config, stores,
commands and thinking levels; `__snapshots__/commands.test.ts.snap` pins
command output.

## Ownership

- `tests/*.test.ts` and `tests/__snapshots__/`.
- A new suite follows the closest existing suite for its subject (module
  map: `.agents/FILES.md`; suite intent: each file's header comment).

## Local Contracts

- **Hermetic by default.** Anything that touches `<piConfigDir>` runs
  against a temp `PI_CODING_AGENT_DIR` set in `beforeEach` and restored in
  `afterEach` (pattern: `tests/crashes.test.ts`, `tests/secrets.test.ts`);
  no test may read or write the real agent dir. Suites that never touch a
  store stay pure (no env redirect needed).
- **Deterministic by default, live by opt-in.** Mocked classifier/backend
  fixtures for the default path; a real end-to-end path exists only behind
  an env switch that skips otherwise (pattern: `SWITCHBACK_SECRETS_LIVE` in
  `tests/secrets.test.ts`). The one default-path process spawn is
  `tests/atomic-write.test.ts` holding a file open in a PowerShell child -
  the EPERM reproduction needs a real OS handle and has no credential or
  backend behind it (`it.runIf(win32)`, like the powershell case in
  `tests/secrets.test.ts`).
- **Synthetic values only.** Never a real credential, machine path,
  account handle or email in a fixture or assertion — assertion output is
  printed, and the personal-data scrub (root AGENTS.md project rule 7)
  applies to anything derived from a test.
- **Secret material is asserted absent, never printed.** Round-trip
  assertions use marked-fake sentinels; on-disk checks read the bytes and
  assert the value is missing. Snapshot updates are deliberate, reviewed
  diffs — never regenerated wholesale to make a run green.

## Verification

- `npx vitest run` (full suite) before reporting a milestone; opt-in live
  tests are exercised separately when their path is under change
  (e.g. `SWITCHBACK_SECRETS_LIVE=1 npx vitest run tests/secrets.test.ts`).
- **Graph nuance:** `tsconfig.json` includes only the root `index.ts`
  graph, so the `npx tsc --noEmit` gate does not type-check test files —
  vitest transpiles them without checking. Keep them type-clean and
  verify with a targeted `npx tsc --noEmit <files>` run when in doubt
  (same flags as `src/AGENTS.md` → Verification).

## Child DOX Index

None — no sub-boundaries under `tests/`.
