# packages/opencode — the OpenCode adapter

## Purpose

The OpenCode V2 plugin, `opencode-switchback`. `setup()` registers the `retry`
session hook plus the `/switchback` and `/switchback-unblock` commands. OpenCode
has no per-request virtual-model dispatch, so the fallback job moved to the turn
boundary around the retry hook: classify the failure through the configured
classifier, update the shared block state, `ctx.session.switchModel()` to the
next effective fallback so the retry OpenCode already scheduled runs on it — or,
when nothing effective is left, flip the hook's `decision` to `retry: false` so
OpenCode surfaces the failure instead of looping into blocked models. Design and
tradeoffs: `.agents/plans/opencode-support.md` (option B shipped first; option A,
the custom provider runtime for true in-flight routing, is still open as
`switchback-wix.1`).

Config, block state, crash corpus and the configured classifier are shared with
the pi adapter unchanged (`switchback-core` config layers, default state dir,
`SWITCHBACK_DIR` override) — root AGENTS.md project rule 3 owns the location.

## Ownership

- `packages/opencode/src/index.ts`.
- This doc owns the plugin's contracts. The decision logic it calls is
  `packages/core` (`packages/core/AGENTS.md`); the module → path table is
  `.agents/FILES.md`; the suite pinning the retry flow is
  `tests/opencode-adapter.test.ts`.

## Local Contracts

- **OpenCode V2 only.** `https://opencode.ai/v2/docs` is the only valid source;
  the V1 plugin API is a different, incompatible surface (`.agents/POLICIES.md`
  → Reference material).
- **No virtual-model dispatch, ever, by assumption — verified against the
  shipped hook set.** The retry hook runs after OpenCode classifies a failure
  and proposes its own policy, before any retry is scheduled; it can mutate
  `input.decision` but cannot re-point the pending attempt. Advancing means
  `ctx.session.switchModel()` for subsequent requests (turn boundary, not
  in-flight).
- **Structural host shapes only.** The plugin imports nothing from
  `@opencode/client` or the generated schema; only `@opencode/plugin`'s plugin
  surface plus local structural interfaces (`RetryPayload`, the catalog model
  shape) that the host object satisfies. The generated client types are not
  exported by the package's exports map — narrow from what the context hands
  you, the way `handleRetry` does.
- **Reuse, do not fork, the decision logic.** Classification, blocking, block
  state and crash rows come from `switchback-core` (`assessFailure`,
  `readBlockedMap`, `pickNextEffective`, `recordDecideCrash`); a behaviour that
  needs a host capability becomes a port in `packages/core/src/ports.ts`, never
  a parallel implementation here.
- **No verdict, no detour.** When the classifier cannot produce a decision, the
  sighting is recorded (`recordDecideCrash` `blind-cycle`) and the session keeps
  OpenCode's own retry policy — never a fabricated verdict (root AGENTS.md rule
  1 is the rule, this is the OpenCode-side pointer). Likewise a failure on a
  model no configured chain lists is untouched, silently: OpenCode's policy
  stands.
- **Transient budget is OpenCode's.** The hook passes `transientRetries: 0` on
  every sighting: a transient cycle pi would count in flight is one OpenCode's
  own retry policy already scheduled. Do not thread host attempt counts into
  core without reopening that seam.
- **State goes through the core stores** (`blocks.json`, `crashes.json`) with
  the account-scoped default directory + `SWITCHBACK_DIR` override; the core
  owns format, migration and atomic writes.

## Work Guidance

- Verify an API against the installed package's own declarations
  (`node_modules/@opencode/plugin/dist/promise/*.d.ts`) before using it; the V2
  docs are the record for reporting claims. Record what the docs leave unstated
  in the plan file, not this contract.
- Every host call the adapter makes belongs in this package; every decision it
  makes belongs in `packages/core`. A new host capability (a new session hook,
  a new command) needs both an integration here and a `fakeCtx` row in
  `tests/opencode-adapter.test.ts` or it is untested.
- The catalog is re-read per decision (`ctx.model.list()` once per retry
  sighting); OpenCode owns its catalog live — do not snapshot it across
  decisions in shared state.

## Verification

- `npx tsc --noEmit` (root graph covers `packages/**`) and `npx vitest run`;
  the adapter suite is `tests/opencode-adapter.test.ts` (hermetic via
  `SWITCHBACK_DIR`/`PI_CODING_AGENT_DIR`/`USERPROFILE`, classifier served by a
  stubbed `globalThis.fetch`).
- Nothing here is loaded by the pi extension: the extension's loader contract
  (`pi.extensions`) and `packages/pi` are unaffected by changes in this package.
- A behaviour claim about OpenCode that has not been run in OpenCode is a
  hypothesis. Say which half is verified and which is not.

## Child DOX Index

None — no sub-boundaries under `packages/opencode/src/`.
