# Architecture

## File roles

| File | Role |
|---|---|
| `index.ts` | pi extension entry: registers one virtual model per config entry and six commands (`/switchback`, `/switchback-config`, `/switchback-next`, `/switchback-blocked`, `/switchback-crashes`, `/switchback-annotate`). Live config reload on every route: edits to `switchback.yaml` are picked up without a restart; a broken layer emits one warning and the session keeps the last good config. |
| `src/types.ts` | Shared type definitions (`SwitchbackConfig`, `SwitchbackState`, `ClassifiedError`, `Availability`, `ResolvedEntry`, `ResolvedFallbacks`). |
| `src/atomic-write.ts` | The one atomic file writer every store uses: write `<file>.<pid>.<seq>.tmp` in the destination directory, then rename it over the destination, retrying with a backoff (7 attempts, 10…320 ms) because Windows refuses the rename with `EPERM` while another process holds the destination — an indexer, an antivirus scanner, a second pi session. A fixed `<file>.tmp` made two writers fight over one staging file. Reports failure as `AtomicWriteError`; each store wraps it in its own error type. |
| `src/config.ts` | `loadConfig()`: layer aggregation (project-local `<cwd>/.pi/switchback.yaml` on top of the global copy; a duplicated model id means the project entry wins wholesale; a broken layer throws), parse, validate, `debug` flag (YAML only; see Configuration). |
| `src/state.ts` | Read/write of `<piConfigDir>/switchback/blocks.json` (blocked-until map, lazy prune; default 5-minute block when no reset time is parseable, `now + 5 * 60_000` in `blockModel()`) AND `<piConfigDir>/switchback/pin.json` (the per-virtual-model pin for `/switchback-next`). Migration from legacy `<cwd>/.pi/switchback.json` on first read. |
| `src/classify.ts` | `classifyError()`: classifier-only with Tier 2b annotation cache. Four branches - (0) annotation cache hit (raw-message sha256 in `crashes.json` with user `annotated`) returns the annotated class with `source: "annotation"`; (a) `stopReason === "length"` (pi's typed field) short-circuits to `overflow` with `source: "structured"`; (b) the configured `ctx.modelRegistry.classify()` is the ONLY message-derived decision (`source: "classifier"`); (c) classifier missing / unresolvable / timeout / threw / unparseable returns a tagged `no-classifier` signal. The `reset` answer is a rubric index into `RESET_RUBRIC` (9 levels, inside `MAX_SCORE_LEVELS`), never a 0-100 value. Note `scope` is recorded but not read by `routing.ts` - blocks are account-scoped by design. No keyword sets, no HTTP-code patterns, no regex-based reset extractor, no prompt criteria taken from collected traffic (root AGENTS.md project rule 7). Exports `PROMPT_VERSION`, stamped on every classifier verdict. |
| `src/routing.ts` | `decide()`: routing logic. On `no-classifier`: report via `inputs.notify` (wired to `ctx.ui.notify` in `index.ts` when `ctx.hasUI`) and cycle to the next non-blocked effective entry — no blocks write on this path. On a classifier verdict quota / auth / unknown: block the failed model with the classifier-supplied reset, advance **forward** from it. On transient: retry-same up to `MAX_TRANSIENT_RETRIES`, then advance forward. On overflow: stick without blocking. `assessFailure()` is the single place a failure becomes a verdict plus a block, shared with `observeUnretriedFailure()` (the `agent_end` fallback for failures pi declines to retry) — both live in `src/failure.ts`, which decides what a failure *means*; this module decides where to go next. Every retry with a real failure is also recorded in `crashes.json` (one row per outcome) so the corpus grows during normal use. |
| `src/failure.ts` | What a failed request *means*: `assessFailure()` classifies it through `src/classify.ts`, writes (or clears) the account-scoped block, and reports the verdict; `observeUnretriedFailure()` is the `agent_end` fallback for failures pi declined to retry, where there is no retry left to re-route and blocking plus a `crashes.json` row is the whole useful act. Both go through `assessFailure`, so the verdict and the block come from the same code whichever path a failure arrives on. Owns `MAX_TRANSIENT_RETRIES` and `recordDecideCrash()` (which `decideRetry` also calls). No-classifier blocks nothing — there is nothing to justify a block with, and the caller cycles instead. |
| `src/build-route.ts` | `buildRoute()` and `resolveDispatchLevel()`: turning a decision into what pi dispatches. Resolves the chosen id back to a pi `Model`, settles the reasoning level against *that* model (categories are fixed, level maps are not), clamps it to what the model implements, and attaches router state. Emits `ConfigInvalidError` (with greyed detail) when zero effective fallbacks remain; throws `Error("switchback: ... exhausted")` when the user is quota-locked across every entry. Never throws for missing picks on greyed entries. When `debug: true` (or `SWITCHBACK_DEBUG=1`) it emits one notification per switch naming the verdict, the reset window and how the requested category resolved. |
| `src/crashes.ts` | Atomic read/write of `<piConfigDir>/switchback/crashes.json` with sha256-keyed dedup. Recording (`recordCrash`) updates count/last/verdictHistory. Tier 2b annotation cache (`annotateCrash`) writes a user-confirmed class that short-circuits the classifier call on those exact bytes. Corrupt files are quarantined (`.corrupt.<ts>` suffix) and a fresh empty map is returned so the router keeps working. |
| `src/availability.ts` | `resolveFallbacks()` and `pickNextEffective()`: per-route catalog validity, degraded mode, and the ordered forward walk (`startAfter` + wrap) that makes consecutive failures visit the fallbacks in order. |
| `src/thinking.ts` | `SWITCHBACK_THINKING_LEVELS`, `availableCategories()`, `chooseThinkingLevel()`: the fixed reasoning-level category scale and its per-model resolution by the classifier at model activation. See Reasoning levels. |
| `src/idle.ts` | `decideIdleReset()`: the per-virtual-model `idleReset:` policy. Idleness is measured from the conversation's newest message timestamp; fixed thresholds answer arithmetically and `classifier` mode asks the decision model (30-minute floor). Routing order is pin → idle reset → stickiness. |
| `src/context-fit.ts` | `fitsContext()` / `usableContextTokens()`: whether a candidate can hold the current context, plus `chooseContextCandidate()` — the question that lets the decision model pick between several fitting candidates (the deterministic pick is the floor). pi sizes the conversation against the **routed** model, so this is used to *prefer* a fitting switch target — never to exclude one, and never on a sticky route. |
| `src/simulate.ts` | `loadSimulate()`, `simulateRetry()`: test harness for synthetic errors. |
| `src/index.ts` | The barrel: re-exports the public surface so a consumer can `import { decide, … }` without enumerating modules. Nothing else in the repo loads it, so `tests/barrel.test.ts` is what catches a re-export naming a symbol its module no longer exports. |
| `src/systemone.ts` | `systemOneClassifier()` and `classifierState()`: switchback's own SystemOne transport. `classifierState()` sends the error text as a **bare string**, the shape every backend accepts — an object shape is rejected by Respan with a 400. |
| `src/classifier-catalog.ts` | The provider choices the `/switchback-config` wizard offers, derived at runtime from pi's registry (`getRegisteredProviderIds` / `getProvider` / `getModelsOfType("classifier", …)`). Nothing is hardcoded: a provider or model id added to pi appears here automatically. Also derives the clash guard — pi replaces a provider's whole model list when an extension registers under its id, so a direct endpoint may only use a provider pi has no chat models for. |
| `src/local-classifier.ts` | `groupLocalEndpoints()` + `registerLocalClassifier()`: registers config-declared SystemOne endpoints with pi. Grouping is by `provider|baseUrl`, so one endpoint carrying several `decisionModels` registers them all in a single call rather than overwriting each other. |
| `src/classifier-discovery.ts` | `discoverOllamaModels()`: lists a local endpoint's models and keeps only those tagged with the `decision` capability, which is what makes the wizard's "browse" list trustworthy. |
| `src/classifier-probe.ts` | The `/switchback-config` capability test: sends the real question shape to the real endpoint and reports which of choice / score / noul came back usable. Validates a `score` answer against the rubric extent, not a 0-100 range. |
| `src/config-editor.ts` | Comment-preserving YAML load / mutate / save for the interactive dialogue. Every mutation goes through a typed editor function and is saved immediately, so a failed save reverts exactly the failed action by reloading from disk. |
| `src/dialogue.ts` | The `/switchback-config` shell: layer chooser, main menu, per-model menu, fallback editor. |
| `src/dialogue-ui.ts` | The dialogue's shared primitives: session, screen titles, validated read, save-or-revert, every prompt, and the pure `describeJev` / `secretNameFor` formatters. Both halves depend on it so neither imports the other. |
| `src/dialogue-classifier.ts` | The decision-model half of the dialogue: classifier picker, `decisionModels` entry menu, and the create / edit / rename / test / delete wizard. |
| `src/model-picker.ts` | The searchable model picker behind `/switchback-next` and the wizard's model step. |
| `src/secrets.ts` | The encrypted credential store (DPAPI). The dialogue only ever receives a derived secret *name*; the value goes straight to the store, so a literal API key is unrepresentable in `switchback.yaml`. |
| `src/atomic-write.ts` | The one atomic writer behind every store: a fresh staging path per write plus a rename retried with backoff, because Windows refuses the rename with `EPERM` while anything else holds the destination. |
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
