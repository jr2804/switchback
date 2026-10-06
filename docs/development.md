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
  router reports visibly and cycles. **Jev prompt v1 LOCKED 2026-10-04** against 41
  passively-collected real error samples (see
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

## Test layout

**279** unit/integration tests across 17 files, plus **11 opt-in**
live cases (10 live-classifier, 1 live DPAPI store) that skip unless
their environment gates are set:

| File | Tests | Covers |
|---|---|---|
| `tests/router.test.ts` | 85 | routing, blind cycle, classifier-mocked verdicts, session stickiness, pin override, idle reset, context-window fit and the classifier's candidate choice, forward failover walk, catalog validity, exhaustion, thinking-level resolution, state, buildRoute |
| `tests/dialogue.test.ts` | 35 | config editor: comment-preserving round-trip, layers, decision models, secret references; dialogue flows incl. the layer chooser, the searchable picker and the classifier test offer (scripted UI, hermetic) |
| `tests/classifier-probe.test.ts` | 11 | the capability probe: prompt shape, answer validation, verdict and report, local endpoint path (injected fetch) |
| `tests/model-picker.test.ts` | 8 | picker items and key routing: fuzzy filtering, Tab/Enter accept, exact typed reference, cancel |
| `tests/context-fit.test.ts` | 6 | window arithmetic and the candidate-choice question: classifier pick, no-classifier fallback, answer outside the offered set (hermetic) |
| `tests/classifier-catalog.test.ts` | 6 | provider choices, local endpoint env defaults, base URL normalization |
| `tests/crashes.test.ts` | 25 | crash store, dedup, Tier 2b cache, annotation, corrupt-file quarantine |
| `tests/config.test.ts` | 23 | `DEFAULT_CONFIG`, `findModelConfig`, layer aggregation, YAML-only, classifier-field validation, debug flag |
| `tests/secrets.test.ts` | 23 (1 opt-in) | encrypted DPAPI store: round-trip, corruption quarantine, version refuse; live DPAPI gated on `SWITCHBACK_SECRETS_LIVE` |
| `tests/classify-inventory.test.ts` | 15 | corpus-preservation in `switchback.simulate.json` |
| `tests/state-migration.test.ts` | 5 | legacy `<cwd>/.pi/switchback.json` → new path migration |
| `tests/systemone.test.ts` | 5 | switchback's own System One transport (hermetic; injected fetch) |
| `tests/thinking.test.ts` | 10 | reasoning-level categories, availability, and classifier resolution (hermetic) |
| `tests/idle.test.ts` | 15 | idle-reset thresholds, timestamp extraction, formatting, classifier contract (hermetic) |
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

Run `pi` with `--extension` (or `-e`). Edits to `index.ts` and `src/*.ts`
go live on the next launch — no copy, no symlink.

```bash
cd <repo>

pi --extension ./index.ts --list-models switchback
pi -e ./index.ts --list-models switchback                # equivalent
# provider    model  context  max-out  thinking  images
# switchback  auto   0        0        yes       yes

pi --extension ./index.ts --model switchback/auto
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

When you want the user-extensions copy independent of the dev tree, copy
`index.ts`, `package.json`, `src/`, and `tsconfig.json` into
`~/.pi/agent/extensions/switchback/` and run `npm install` there.

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
npx vitest run      # 210 + 11 opt-in
```

Both must be clean. Do not report a milestone until both pass.
