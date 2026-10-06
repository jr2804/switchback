# Architecture

## File roles

| File | Role |
|---|---|
| `index.ts` | pi extension entry: registers one virtual model per config entry and seven diagnostic commands (`/switchback`, `/switchback-blocked`, `/switchback-crashes`, `/switchback-annotate`, `/switchback-next`, plus `/switchback-config` once sb-2's interactive config dialogue ships). Live config reload on every route: edits to `switchback.yaml` are picked up without a restart; a broken layer emits one warning and the session keeps the last good config. |
| `src/types.ts` | Shared type definitions (`SwitchbackConfig`, `SwitchbackState`, `ClassifiedError`, `Availability`, `ResolvedEntry`, `ResolvedFallbacks`). |
| `src/config.ts` | `loadConfig()`: layer aggregation (project-local `<cwd>/.pi/switchback.yaml` on top of the global copy; a duplicated model id means the project entry wins wholesale; a broken layer throws), parse, validate, `debug` flag (YAML only; see Configuration). |
| `src/state.ts` | Atomic read/write of `<piConfigDir>/switchback/blocks.json` (blocked-until map, lazy prune; default 5-minute block when no reset time is parseable, `now + 5 * 60_000` in `blockModel()`) AND `<piConfigDir>/switchback/pin.json` (the per-virtual-model pin for `/switchback-next`). Migration from legacy `<cwd>/.pi/switchback.json` on first read. |
| `src/classify.ts` | `classifyError()`: classifier-only with Tier 2b annotation cache. Four branches — (0) annotation cache hit (raw-message sha256 in `crashes.json` with user `annotated`) returns the annotated class with `source: "annotation"`; (a) `stopReason === "length"` (pi's typed field) short-circuits to `overflow` with `source: "structured"`; (b) the configured `ctx.modelRegistry.classify()` is the ONLY message-derived decision (`source: "classifier"`); (c) classifier missing / unresolvable / timeout / threw / unparseable returns a tagged `no-classifier` signal. **Jev prompt v4 (2026-10-06)**, locked against the same 41-sample corpus. v1's reset
question asked for a 0-100 value SystemOne never returns — `score` answers are the weighted
average of rubric level indices; v2 sent a 21-level rubric, which TypeSafe's hosted Jev
rejects (`400 Too many score levels`, and a rejected request yields no answers, so every
message classified as `unknown`). v3 sends a 9-level rubric, within the 10-level ceiling both
backends accept (`MAX_SCORE_LEVELS`). v4 rewrote the `scope` question around lexical cues the
message actually carries (a named model, a key/plan/quota, an address) because v3 named only
`unknown` in its instructions and asked for counterfactual judgements, and `unknown` won every
case (`typesafe/jev-latest` answered 84-92% unknown; v4 answers 5/5 correctly on both
backends). Note `scope` is recorded but not read by `routing.ts` — blocks are account-scoped by
design. No
keyword sets, no HTTP-code patterns, no regex-based reset extractor. `reset` answers are a
rubric index into `RESET_RUBRIC`. Exports `PROMPT_VERSION` stamped on every classifier verdict. |
| `src/routing.ts` | `decide()` and `buildRoute()`: routing logic. On `no-classifier`: report via `inputs.notify` (wired to `ctx.ui.notify` in `index.ts` when `ctx.hasUI`) and cycle to the next non-blocked effective entry — no blocks write on this path. On classifier verdict quota / auth / unknown: block the failed model with the classifier-supplied reset, advance **forward** from it. On transient: retry-same up to `MAX_TRANSIENT_RETRIES`, then advance forward. On overflow: stick without blocking. Every switch then resolves the reasoning level for the activated model (`withActivationLevel`); when `debug: true` (or `SWITCHBACK_DEBUG=1`) it also emits one notification per switch naming the verdict, the reset window and how the requested category resolved, and blocked-path decision reasons carry their reset window. Emits `ConfigInvalidError` (with greyed detail) when zero effective fallbacks remain; throws `Error("switchback: ... exhausted")` when the user is quota-locked across every entry. Never throws for missing picks on greyed entries. Every retry with a real failure is also recorded in `crashes.json` (one row per outcome) so the corpus grows during normal use. |
| `src/crashes.ts` | Atomic read/write of `<piConfigDir>/switchback/crashes.json` with sha256-keyed dedup. Recording (`recordCrash`) updates count/last/verdictHistory. Tier 2b annotation cache (`annotateCrash`) writes a user-confirmed class that short-circuits the classifier call on those exact bytes. Corrupt files are quarantined (`.corrupt.<ts>` suffix) and a fresh empty map is returned so the router keeps working. |
| `src/availability.ts` | `resolveFallbacks()` and `pickNextEffective()`: per-route catalog validity, degraded mode, and the ordered forward walk (`startAfter` + wrap) that makes consecutive failures visit the fallbacks in order. |
| `src/thinking.ts` | `SWITCHBACK_THINKING_LEVELS`, `availableCategories()`, `chooseThinkingLevel()`: the fixed reasoning-level category scale and its per-model resolution by the classifier at model activation. See Reasoning levels. |
| `src/idle.ts` | `decideIdleReset()`: the per-virtual-model `idleReset:` policy. Idleness is measured from the conversation's newest message timestamp; fixed thresholds answer arithmetically and `classifier` mode asks the decision model (30-minute floor). Routing order is pin → idle reset → stickiness. |
| `src/context-fit.ts` | `fitsContext()` / `usableContextTokens()`: whether a candidate can hold the current context, plus `chooseContextCandidate()` — the question that lets the decision model pick between several fitting candidates (the deterministic pick is the floor). pi sizes the conversation against the **routed** model, so this is used to *prefer* a fitting switch target — never to exclude one, and never on a sticky route. |
| `src/simulate.ts` | `loadSimulate()`, `simulateRetry()`: test harness for synthetic errors. |
| `switchback.yaml.example` | Config template. The real user config lives at `<cwd>/.pi/switchback.yaml` or `~/.pi/agent/switchback.yaml` and is never shipped. |
| `switchback.simulate.json` | Synthetic error scenarios; used by router tests (`tests/router.test.ts` + the corpus-preservation suite) and by the opt-in live integration test. Not user-facing any more. |

The test suites and their per-file counts live in [Development → Test layout](development.md#test-layout) — one canonical table, so counts cannot drift between pages.

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
