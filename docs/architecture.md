# Architecture

## File roles

| File | Role |
|---|---|
| `index.ts` | pi extension entry: registers the virtual model and six diagnostic commands (`/switchback`, `/switchback-config`, `/switchback-blocked`, `/switchback-crashes`, `/switchback-annotate`, `/switchback-simulate`). |
| `src/types.ts` | Shared type definitions (`SwitchbackConfig`, `SwitchbackState`, `ClassifiedError`, `Availability`, `ResolvedEntry`, `ResolvedFallbacks`). |
| `src/config.ts` | `loadConfig()`: lookup, parse, validate `switchback.yaml` (YAML only; see Configuration). |
| `src/state.ts` | Atomic read/write of `<piConfigDir>/switchback/blocks.json` with lazy pruning. Migration from the legacy `<cwd>/.pi/switchback.json` (per-key max timestamp wins, then delete). Default block duration when no reset time is parseable from the error: 5 minutes (`now + 5 * 60_000` in `blockModel()`). |
| `src/classify.ts` | `classifyError()`: classifier-only with Tier 2b annotation cache. Four branches — (0) annotation cache hit (raw-message sha256 in `crashes.json` with user `annotated`) returns the annotated class with `source: "annotation"`; (a) `stopReason === "length"` (pi's typed field) short-circuits to `overflow` with `source: "structured"`; (b) the configured `ctx.modelRegistry.classify()` is the ONLY message-derived decision (`source: "classifier"`); (c) classifier missing / unresolvable / timeout / threw / unparseable returns a tagged `no-classifier` signal. **Jev prompt v1 LOCKED 2026-10-04** against 41 passively-collected real error samples. No keyword sets, no HTTP-code patterns, no regex-based reset extractor. Exports `PROMPT_VERSION` stamped on every classifier verdict. |
| `src/routing.ts` | `decide()` and `buildRoute()`: routing logic. On `no-classifier`: report via `inputs.notify` (wired to `ctx.ui.notify` in `index.ts` when `ctx.hasUI`) and cycle to the next non-blocked effective entry — no blocks write on this path. On classifier verdict quota / auth / unknown: block the failed model with the classifier-supplied reset, advance **forward** from it. On transient: retry-same up to `MAX_TRANSIENT_RETRIES`, then advance forward. On overflow: stick without blocking. Every switch then resolves the reasoning level for the activated model (`withActivationLevel`). Emits `ConfigInvalidError` (with greyed detail) when zero effective fallbacks remain; throws `Error("switchback: ... exhausted")` when the user is quota-locked across every entry. Never throws for missing picks on greyed entries. Every retry with a real failure is also recorded in `crashes.json` (one row per outcome) so the corpus grows during normal use. |
| `src/crashes.ts` | Atomic read/write of `<piConfigDir>/switchback/crashes.json` with sha256-keyed dedup. Recording (`recordCrash`) updates count/last/verdictHistory. Tier 2b annotation cache (`annotateCrash`) writes a user-confirmed class that short-circuits the classifier call on those exact bytes. Corrupt files are quarantined (`.corrupt.<ts>` suffix) and a fresh empty map is returned so the router keeps working. |
| `src/availability.ts` | `resolveFallbacks()` and `pickNextEffective()`: per-route catalog validity, degraded mode, and the ordered forward walk (`startAfter` + wrap) that makes consecutive failures visit the fallbacks in order. |
| `src/thinking.ts` | `SWITCHBACK_THINKING_LEVELS`, `availableCategories()`, `chooseThinkingLevel()`: the fixed reasoning-level category scale and its per-model resolution by the classifier at model activation. See Reasoning levels. |
| `src/simulate.ts` | `loadSimulate()`, `simulateRetry()`: test harness for synthetic errors. |
| `tests/router.test.ts` | 62 tests covering routing structure, blind cycle (all 5 no-classifier reasons), classifier-mocked quota/auth/transient/unknown (incl. the real MiniMax Token Plan and 529-overload captures), session stickiness, the forward multi-model failover walk, step 8 catalog validity, F2 stopReason short-circuit, exhaustion, reasoning-level resolution, state persistence, config loader, constants, and buildRoute wire-up. |
| `tests/classify-inventory.test.ts` | 15 corpus-preservation tests: every expected scenario in `switchback.simulate.json` is present, incl. the verbatim 2026-10-04 zai 401 probe and the MiniMax Token Plan capture. |
| `tests/crashes.test.ts` | 25 crash-store tests: roundtrip, atomic write, dedup, verdictHistory bound, all 5 no-classifier reasons, all 5 classified verdict classes, Tier 2b annotation cache (unannotated → classifier still called; annotated → short-circuit), annotation validation (5 valid classes + reject), ambiguous short-hash handling, corrupt-file quarantine. |
| `tests/state-migration.test.ts` | 5 migration tests: legacy `<cwd>/.pi/switchback.json` → new `<piConfigDir>/switchback/blocks.json` with per-key max, idempotent, blockModel writes only to the new path. |
| `tests/commands.test.ts` | 6 snapshot + parser tests of the six command outputs and the annotate-args parser. |
| `tests/config.test.ts` | 14 tests covering DEFAULT_CONFIG, findModelConfig errors, cwd-first precedence, the YAML-only lookup, and the classifier-field validation (baseUrl / api / apiKey). |
| `tests/integration-classifier.test.ts` | 11 opt-in tests (10 skipped by default) that drive the real `classifyError` through a real SystemOne transport against the corpus. Gated on `SWITCHBACK_CLASSIFIER_*` env vars — see [Classifier](classifier.md#live-classifier-validation-opt-in). |
| `switchback.yaml.example` | Config template. The real user config lives at `<cwd>/.pi/switchback.yaml` or `~/.pi/agent/switchback.yaml` and is never shipped. |
| `switchback.simulate.json` | Synthetic error scenarios for `/switchback-simulate`. |

## Routing flow

1. `route()` is invoked by pi with a `ModelRouteRequest` (model, messages, reason).
2. `buildRoute()` calls `decide()` with the request, the loaded model config, the
   model registry (as an explicit parameter), and the session branch state.
3. `decide()` resolves the fallback list against the current catalog
   (`resolveFallbacks()`), then dispatches by reason:
   - **`user` / `direct`** — stay on the session's current model. The session is
     sticky: only a blocked or no-longer-available current model is left behind,
     and the walk then continues **forward** from its position (wrapping to the
     head). A branch with no state yet starts at the head of the list.
   - **`continuation`** — stick to `request.previous.model` if it is still
     effective.
   - **`retry`** — quota/auth block the failed model and advance forward from it;
     transient retries the same model once (`MAX_TRANSIENT_RETRIES`) and then also
     advances forward; overflow sticks without blocking. Advancing forward (rather
     than re-scanning from the head) is what makes a chain of failures visit the
     fallbacks in order instead of bouncing between the first two entries.
   - The returned thinking level is resolved for the activated model (see
     Reasoning levels) rather than passed through as the selected category.
4. Every failure writes a row in `crashes.json` (sha256-keyed dedup). A
   classifier verdict is recorded alongside; only a `/switchback-annotate`
   command promotes a row into the Tier 2b cache that short-circuits the
   classifier for those exact bytes.
5. Blocks (`blocks.json`) are written only from a classifier-given class
   - reset, or from the overflow / no-failure-message paths. Blocks clear
   lazily when their reset time passes.

## Reasoning levels

The reasoning levels follow the classifier-only rule: switchback itself never
maps a category to a concrete level with a table.

1. Every switchback virtual model offers the same fixed category scale:

   `off` · `minimal` · `medium` · `high` · `max`

   (`minimal` is pi's name for the level above `off`.) That scale is the user's
   vocabulary and is independent of which physical models are configured.

2. The physical fallbacks do not honour that scale uniformly. Their
   `thinkingLevelMap` decides which levels exist and how each is spelled on the
   wire; `null` means the level does not exist. In the default 4-provider list,
   for example, z.ai GLM supports only **low / high / max** (it cannot disable
   thinking at all), while MiniMax has no map and honours everything up to
   **high**. A category therefore has to be resolved against whichever model is
   activated.

3. When a decision **activates or switches to** a model, `withActivationLevel()`
   asks the configured SystemOne classifier. The state carries the activated
   model, the requested category, the model's supported levels and the route
   context; the single `choice` question is restricted to the levels that model
   really supports, so the answer is always dispatchable. `thinkingSource` on the
   decision records whether the classifier (`classifier`) or the fallback clamp
   (`requested`) decided.

4. If the classifier cannot answer (missing / unresolvable / timeout / threw /
   unparseable) the category is clamped to the model with pi's
   `clampThinkingLevel` — the same value pi would otherwise have dispatched
   silently. A model that supports exactly one category is not asked about at
   all.

5. Sticky routes (session-sticky turns, continuations, same-model retries,
   overflow) keep their level unchanged. This is deliberate: the level is part of
   the provider's thinking signature and prompt cache, so re-deciding it per
   request would invalidate both.

pi clamps again inside every provider before dispatch, so a stale or
non-category level (for example a `low` selection left over from before the
scale) is still never sent to a provider verbatim.

## Known limitations

- **No success-unblock path.** A block clears lazily when its reset time
  passes, or explicitly on the overflow / no-failure-message paths. There is
  deliberately no "a successful response immediately unblocks" path:
  `route()` has no request-succeeded event, and a blocked model is not
  routed to (except in single-model degraded mode), so there is no success
  signal to react to.
- **Classifier unavailability surfaces as a cycle, not a block.** When no
  classifier resolves, the router reports visibly and advances to the next
  non-blocked entry. No block is written on this path.
