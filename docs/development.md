# Development

This page is the maintainer / contributor entry point: implementation status,
test layout, and how to run the extension from a source checkout. End-user
documentation lives in the [User guide](index.md).

## Implementation status

Build steps 1–8 are complete (per the design doc):

- [x] **Step 1** — Skeleton: virtual model registered, returns first configured physical model.
- [x] **Step 2** — `switchback.yaml` user config format (see `switchback.yaml.example`).
- [x] **Step 3** — Atomic blocked-until store at `<piConfigDir>/switchback/blocks.json` (account-scoped; legacy `<cwd>/.pi/switchback.json` migrated on first read).
- [x] **Step 4** — Classifier-only call via `ctx.modelRegistry.classify()`. The blind-cycle fallback
  replaces the heuristic: when the classifier is missing, unresolvable, or its call fails, the
  router reports visibly and cycles. **Jev prompt v5 2026-10-09**: the reset
  question is a 9-level rubric whose levels are the answer space (SystemOne `score`
  answers are weighted averages of level indices, not percentages), kept at or
  under `MAX_SCORE_LEVELS` = 10 because TypeSafe's hosted Jev rejects more with a
  400 and returns no answers at all; and the `scope` question is anchored on the
  general cue each option stands for rather than counterfactuals, with **no worked
  examples** — root AGENTS.md project rule 7 forbids prompt criteria derived from
  collected provider traffic, so a captured message may only ever be a test input.
  v1 locked
  2026-10-04 against 41 passively-collected real error samples (see
  [Classifier → Coverage matrix](classifier.md#coverage-matrix)).
- [x] **Step 5** — `route()` reason dispatch (`user` / `continuation` / `retry` / `direct`) per design doc.
- [x] **Step 6** — Simulate fixture: `switchback.simulate.json` corpus + router tests + opt-in live integration test (no user-facing command).
- [x] **Step 7** — Integration tests: **153 tests** covering all reasons, blind cycle, all five
  no-classifier reasons, classifier-mocked quota / auth / transient / unknown, F2
  (`stopReason` short-circuit), session stickiness + forward failover walk, exhaustion,
  state persistence + migration, crash store
  (roundtrip, dedup, Tier 2b cache, validation, corrupt-file quarantine), command output
  snapshots, config + `DEFAULT_CONFIG` and classifier-field validation. Plus **10 opt-in**
  live-classifier tests, skipped unless configured.
- [x] **Step 8** — Catalog validity & degraded lists: per-route availability resolution, single-model warning, `/switchback` status command.
- [x] **OpenCode plugin** — `packages/opencode/` ships the same routing for
  [OpenCode V2](opencode.md) on the shared `switchback-core` package and shared
  block state: the chains are published as selector-visible `switchback/*`
  models, and a delegating provider-package route dispatches each request to
  the physical model the router picks, failing over inside the same request.
  The TUI half adds real toasts and the `/switchback-config` menu; the GUI half
  (`./gui-experimental`, a prebuilt Vite bundle) brings the same toasts and the
  same menu to OpenCode Desktop over the app's own dialogs. Pinned by
  `tests/opencode-*.test.ts`; live-instance exercise still open
  (`switchback-wix.10`).

## Release automation

Push to `main` tags a CalVer `vYYYY.0M.N` via `calver-release.yml`, which
triggers `publish-npm.yml`: `npm ci` + `tsc` + `vitest`, version stamped in
runner (no commit), then the three packages (`switchback-core`,
`pi-switchback`, `opencode-switchback`) publish with provenance. Tags are
authoritative; see [Versioning](versioning.md).

## Test layout

**424** unit/integration tests across **27** files, plus **11 opt-in**
live cases (10 live-classifier, 1 live DPAPI store) that skip unless
their environment gates are set:

| File | Tests | Covers |
|---|---|---|
| `tests/router.test.ts` | 100 | routing, blind cycle, classifier-mocked verdicts, session stickiness, pin override, idle reset, context-window fit and the classifier's candidate choice, forward failover walk, catalog validity, exhaustion, thinking-level resolution, state, buildRoute, manual disables (walk skip, session stickiness, pin, exhaustion), and the unretried-failure fallback (`observeUnretriedFailure` blocks and the next turn walks forward) |
| `tests/config.test.ts` | 28 | `DEFAULT_CONFIG`, `findModelConfig`, layer aggregation, YAML-only, classifier-field validation, orphan `decisionModels` rejection, reserved-provider rejection, debug flag |
| `tests/dialogue.test.ts` | 35 | config editor: comment-preserving round-trip, layers, decision models, secret references; dialogue flows incl. the layer chooser, the searchable picker and the classifier test offer (scripted UI, hermetic) |
| `tests/secrets.test.ts` | 23 (1 opt-in) | encrypted DPAPI store: round-trip, corruption quarantine, version refuse; live DPAPI gated on `SWITCHBACK_SECRETS_LIVE` |
| `tests/crashes.test.ts` | 25 | crash store, dedup, Tier 2b cache, annotation, corrupt-file quarantine |
| `tests/classify-inventory.test.ts` | 15 | corpus-preservation in `switchback.simulate.json` |
| `tests/idle.test.ts` | 15 | idle-reset thresholds, timestamp extraction, formatting, classifier contract (hermetic) |
| `tests/classifier-probe.test.ts` | 11 | the capability probe: prompt shape, answer validation, verdict and report, local endpoint path (injected fetch) |
| `tests/classifier-catalog.test.ts` | 9 | provider choices, local endpoint env defaults, base URL normalization |
| `tests/model-picker.test.ts` | 8 | picker items and key routing: fuzzy filtering, Tab/Enter accept, exact typed reference, cancel |
| `tests/classifier-discovery.test.ts` | 6 | live local-endpoint model discovery filtered by the `decision` capability |
| `tests/context-fit.test.ts` | 6 | window arithmetic and the candidate-choice question: classifier pick, no-classifier fallback, answer outside the offered set (hermetic) |
| `tests/atomic-write.test.ts` | 3 (1 win32-only) | the shared store writer: a fresh staging path per write, no staging file left behind, and a rename that survives a Windows handle held on the destination by a PowerShell child — the EPERM reproduction, which fails against the old two-immediate-attempt shape |
| `tests/state-migration.test.ts` | 5 | legacy `<cwd>/.pi/switchback.json` → new path migration |
| `tests/systemone.test.ts` | 5 | switchback's own System One transport (hermetic; injected fetch) |
| `tests/commands.test.ts` | 4 | the registered command surface and its snapshot |
| `tests/opencode-adapter.test.ts` | 15 | the OpenCode adapter end to end (hermetic fake harness): provider publication, quota block + in-request failover, pre-blocked exhaustion, out-of-chain silence, no-classifier blind cycle, empty-message short-circuit, `secret:` resolution, the status/unblock/pin commands, and the manual disable list |
| `tests/opencode-config-command.test.ts` | 38 | the `/switchback-config` grammar: every verb against a real temp layer file, layer pinning and reset, the last-model guard, usage and loader-error text, and the RPC `state`/`config` round trip |
| `tests/opencode-notices.test.ts` | 15 | the notice channel: transcript fallback with nothing attached, sink refcounting, a throwing sink, the RPC definition staying JSON Schema, and the `unknown`-wire readers dropping malformed payloads |
| `tests/opencode-tui.test.ts` | 9 | the TUI half: attach/retry/detach lifecycle, notice → toast (with and without `sessionID`), the slash command, and an unreachable server |
| `tests/opencode-tui-guide.test.ts` | 15 | the guided menu: every screen dispatching the layer-1 verb a typed command would, the scripted dialog flow, and cancel paths |
| `tests/opencode-gui.test.ts` | 12 | the GUI half's host-free logic: the app's dialogs adapted to the guide's contract, notice severity → toast variant, attach-before-subscribe ordering, an unreachable server, and a rejected edit reported without losing the menu |
| `tests/disabled.test.ts` | 7 | the manual disable store (`disabled.json`): missing file, idempotent disable with a stable stamp, no expiry, enable, clear-all count, hand-edited non-number rejection, atomic write |
| `tests/thinking.test.ts` | 10 | reasoning-level categories, availability, and classifier resolution (hermetic) |
| `tests/barrel.test.ts` | 2 | `packages/pi/src/index.ts` resolves and exposes the documented entry surface — nothing else loads it, so a bad re-export would otherwise ship |
| `tests/imports.test.ts` | 2 | shipped code never value-imports a host-package subpath (install-safe) |
| `tests/integration-classifier.test.ts` | 1 (10 opt-in) | live classifier against the preserved corpus (gated on `SWITCHBACK_CLASSIFIER_*`) |

## From source

For the regular end-user install, see the
[Quickstart in the README](https://github.com/jr2804/switchback/blob/main/README.md#quickstart) (`pi install …`).
The instructions below are for contributors and for running the extension
from a local checkout.

### Prerequisites

- Node + `npx` (for `tsc` and `vitest`)
- [pi](https://github.com/earendil-works/pi)
- A clone of this repository

```bash
git clone https://github.com/jr2804/switchback.git
cd switchback
npm install
```

`npm install` installs the dev dependencies used by the type checker and the
test runner. It does not download any models.

### Path A — dev mode

Run `pi` with `--extension` (or `-e`). Edits to `packages/pi/index.ts` and
the modules under `packages/{pi,core}/src/` go live on the next launch — no
copy, no symlink.

```bash
cd <repo>

pi --extension ./packages/pi/index.ts --list-models switchback
pi -e ./packages/pi/index.ts --list-models switchback    # equivalent
# provider    model  context  max-out  thinking  images
# switchback  auto   0        0        yes       yes

pi --extension ./packages/pi/index.ts --model switchback/auto
```

### Path B — daily driver (junction / symlink)

The whole project directory is junction-linked into
`~/.pi/agent/extensions/switchback/`, so any edit to the source tree goes
live on the next launch.

**Windows (junction, no admin needed):**

```bash
mklink /J C:\Users\<you>\.pi\agent\extensions\switchback <repo>
pi --list-models switchback
pi --model switchback/auto
```

**macOS / Linux (symlink):**

```bash
ln -s /path/to/switchback ~/.pi/agent/extensions/switchback
pi --list-models switchback
```

### Self-contained variant

When you want the user-extensions copy independent of the dev tree, install
the published packages instead — `npm install pi-switchback`, which pulls
`switchback-core` with it (see the [versioning page](versioning.md) for the
release flow). To copy a checkout by hand, take `packages/pi/index.ts`,
`packages/pi/package.json`, `packages/pi/src/`, `packages/core/`, and
`tsconfig.json` into `~/.pi/agent/extensions/switchback/` and run
`npm install` there.

### First-run verification

In the TUI:

```text
/model switchback/auto
/switchback                    # status, effective vs greyed entries, active blocks
/switchback-config             # config source + ordered fallback list
```

Live call:

```bash
pi --model switchback/auto -p "ping" --no-tools   # -> pong
```

## Verification gate

Before considering any task done:

```bash
npx tsc --noEmit    # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npx vitest run      # 412 + 11 opt-in
```

Both must be clean. Do not report a milestone until both pass.
