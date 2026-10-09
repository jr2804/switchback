# HISTORY.md

Durable decisions, recorded with git refs. Add new entries at the top.
Routine history stays in `git log`; only decisions that changed the
project's direction, contract, or policy belong here.

## 2026-10-09 — Nothing decides from historical error text (project rule 7, prompt v5)

A captured corpus of provider error messages is a **test input, never a source of truth for
behaviour**. Root AGENTS.md gained project rule 7 to say so: no tuning of `JEV_QUESTIONS`
criteria, `RESET_RUBRIC` levels or any threshold against collected messages or status codes,
and no enumerating providers or codes - they drift, and the space of providers x models x codes
is far too large to cover. Rule 1 now cross-references it, and rules were renumbered 1-10.

The rule was not hypothetical. Prompt v4's `scope` question had been rewritten three days
earlier and carried worked examples lifted verbatim out of the captured corpus
(`'GLM 5h window'`, `'invalid API key'`, `'monthly cap'`, ...) - and that rewrite was what took
scope from 0/5 to 5/5. v5 keeps v4's *general* cue for each option (a named model or series; a
credential, plan, balance or usage quota; an address or region) and removes the examples.
Measured on two held-out messages never present in the corpus:

```text
                            with examples   general-only
typesafe/jev-latest              7/7            7/7
parable/tinyjev:latest           7/7            5/7
```

The hosted classifier never needed the anchors; a 4.2B local model did, losing `weekly token
limit exhausted` and `monthly cap`. The hosted path is what the shipped config uses, so the
recorded cost is confined to the local fallback and the accuracy that matters is unchanged.
There is deliberately **no model-dependent prompt wording**: one prompt, whatever the backend.

What may still change a prompt is a general property of the question or the protocol - the
three earlier revisions were each one: a `score` answer is a rubric index rather than a
percentage (v2), TypeSafe rejects more than ten score levels (v3), `unknown` must not be the
path of least resistance (v4).

The bead tree was reframed to match. `switchback-bqq` was "Classifier validation & prompt
hardening", whose stated method was to collect provider error shapes and re-lock the prompt when
new ones arrived - the behaviour rule 7 forbids. It is now "Grow the real-error corpus used as
classifier test input". The four user-gated captures remain legitimate *as fixtures*; what they
may never do is change the prompt.

## 2026-10-09 — `src/failure.ts`: what a failure means, split from `src/routing.ts`

`routing.ts` passed the ~500-code-line rule in `src/AGENTS.md` at 458 and then
blew past it at 605 without gaining a symbol - the `gts` formatting pass
reflowed dense one-call lines into multi-line ones. The seam chosen is not the
three-layer split the orchestrator hypothesised (state helpers / failure
assessment / decision core, ~95 / 250 / 380) but a two-module one, because the
graph supports it and the third layer was not a layer:

- **`src/failure.ts`** owns what a failure *is*: `assessFailure()` (classify,
  block / unblock, report), `observeUnretriedFailure()` (the `agent_end`
  fallback), `MAX_TRANSIENT_RETRIES` and `recordDecideCrash()`. The reason this
  is a real seam and not a size cut: one of its two callers is not routing at
  all - the `agent_end` hook in `index.ts` calls `observeUnretriedFailure` for
  failures pi declined to retry - and the blocking policy has its own reasons
  to change (a classifier answer, a `stopReason`, a block-map write).
- **`src/routing.ts`** keeps `decide()`, `decideRetry()`,
  `pickWithContextFit()` and the state/id helpers: 451 code lines, down from
  605.
- The hypothesised "state/id bookkeeping" layer stayed put (95 lines of small
  helpers, one consumer). Splitting it out would have cost a `FILES.md` row and
  a barrel edit to hold code that only `decide()` calls.
- The pass-through re-export at the old `routing.ts:75-82` is gone; `index.ts`,
  `src/simulate.ts` and `tests/router.test.ts` now name `build-route.ts` or
  `failure.ts` for what those modules own.
- `routing.ts`'s private `isBlockedNow(modelId, blocked, now)` was deleted in
  favour of `state.ts`'s already-exported
  `isBlocked(modelId, now, map)` - the same predicate with the arguments the
  other way round, already used by root `index.ts` and the tests. Both halves of
  the new seam needed it, and `state.ts` owns `BlockedMap`; a third module for
  four lines, or a copy in each, would have been worse.

Verified as a move, not a rewrite: the bodies were sliced by line range and
every non-blank body line of the old file is present in one of the two new
modules - 712 checked, 0 lost. The 21 that differ are the deleted
`isBlockedNow` and its six call sites (argument order), three doc comments
(`recordDecideCrash` has two callers, not one; `describeNoClassifier` is used
in one place, not three; `assessFailure`'s "unchanged from the retry path"
policy note is now the module header's, so the duplicate was cut), `export`
added to `recordDecideCrash`, and one statement `format-ts` rejoined after the
argument reorder. The import graph over `index.ts` + `src/` (27 modules, 101
edges) has no cycle involving either file; the only `classify.ts` <-> `crashes.ts`
loop is `import type`, so it erases. `src/failure.ts` is inside the `tsc` graph
(root `index.ts` imports it), so no targeted run was needed.

## 2026-10-09 — One atomic writer for every store (`src/atomic-write.ts`)

`npx vitest run` failed intermittently with `EPERM: operation not permitted,
rename '<...>\crashes.json.tmp' -> '<...>\crashes.json'` out of
`tests/crashes.test.ts` ("verdictHistory appends and is bounded at 50 entries"),
measured at roughly one full run in three and only under parallel load. Both
defects the shape had were real:

- The comment claimed "retry once after a small backoff"; the code slept
  **zero** milliseconds between the two attempts. Measured on this host, holding
  a file open for 150 ms from another process refuses every rename aimed at it
  for the whole hold (Windows denies sharing deletion), and the hold lands at
  230-260 ms of real time - so an immediate retry cannot win, ever.
- The staging path was a fixed `<path>.tmp`, so two pi sessions sharing
  `<piConfigDir>/switchback/` fought over one staging file: the first rename
  moves the *other* writer's bytes away and the loser then fails on a source
  that is gone.

So all four stores now write through one exported writer,
`writeFileAtomic(path, contents)`: staging path per write
(`<file>.<pid>.<seq>.tmp`), 7 rename attempts with a doubling backoff
(10...320 ms), the staging file removed on failure, and an `AtomicWriteError`
carrying the last fs error as its `cause`. A store that has its own error
vocabulary wraps it - `CrashError`, `SecretsError`, and `config-editor.ts`'s
existing "cannot write config" message; `state.ts` has none today and lets
`AtomicWriteError` out as it is.

Scope was the whole set, not just `crashes.ts`: `src/AGENTS.md` already made
"tmp + rename, the state.ts pattern" a contract shared by every store, and a
fix in one store with the same latent bug in three others would have left the
contract a lie - and `secrets.ts`, whose blobs are irreplaceable, had the bare
rename with no retry at all.

The regression test reproduces the failure rather than asserting the absence of
one: `tests/atomic-write.test.ts` holds the destination open from a PowerShell
child (no `FILE_SHARE_DELETE`), checks that a rename really does fail there,
then calls the writer and requires it to complete. It **fails 5/5 against the
old two-immediate-attempt shape** and passes with the backoff (re-measured
independently: both old attempts land 2-14 ms into a ~312 ms EPERM window). Its
reproduction guard is why the earlier draft was flaky: the child's `held` signal
can arrive after the hold lapsed under load, so the test retries the round and
fails if it never observes an active hold.

After the change: **36 consecutive full-suite runs, zero failures** of this kind
(one unrelated 30 s `tests/barrel.test.ts` import-timeout surfaced while the
machine was saturated by that loop, then 26/26 clean).

## 2026-10-06 — Scope question anchored on lexical cues (PROMPT_VERSION v4)

`scope` came back `unknown` for every message on every backend. Not a parsing
bug: the raw answers were well formed, and `typesafe/jev-latest` put 84-92% on
`unknown` with `account` second. Two causes, both in the prompt. The
instructions named only one option ("Pick 'unknown' if not stated"), handing it
the model's prior mass, and the criteria were counterfactuals the model cannot
check from a message ("other models on the same provider still work",
"other regions or other accounts are unaffected"), so inference failed and
`unknown` - trivially satisfiable as "scope is not stated" - won.

v4 rewrites the question around what a message actually says: a named model or
series, a key / plan / balance / quota, an address or region. Each option
carries an example from real traffic, and `unknown` is now the last resort
rather than the default. Measured after the change, **5/5 correct on both
backends**: `weekly token limit exhausted` / `monthly cap` / `invalid API key`
-> `account`, `GLM 5h window` -> `model`, a bare 503 -> `unknown`.

Worth recording alongside it: `scope` is recorded in the classification and in
`crashes.json` verdicts but **never read by `routing.ts`** - blocks are
account-scoped by design (`src/state.ts`), so the previous `unknown` cost
nothing behaviourally and this change buys truthful metadata rather than
different routing. If scope is ever meant to drive block granularity, that is a
separate design decision, not a prompt fix.

Also settled here: `pi auth check --provider typesafe` is now `ready`, and the
live config points all three virtual models at `decisionModel: jev`.

## 2026-10-06 — SystemOne allows at most 10 score levels; reset rubric is 9 (PROMPT_VERSION v3)

Found by probing the live catalog classifier, not by a test: with the v2
21-level `RESET_RUBRIC`, `typesafe/jev-latest` answers
`400 {"detail":"Too many score levels. Must have at most 10 levels."}` and
returns **no answers at all**. A rejected request is not reported as an error
by our transport, so every message silently classified as
`class=unknown scope=unknown` with no reset - the catalogue path looked
installed and healthy while doing nothing. Ollama allows 26
(`SystemOneScoreQuestion.criteria.maxItems`); the tighter backend sets the
ceiling, so `MAX_SCORE_LEVELS = 10` now lives in `src/classify.ts` beside the
rubric and a test asserts the criteria we actually send stay within it.

The rubric is the 9-level ladder measured earlier on a local `tev1:0.8b` (mean
log2 placement error 5.78 bits, against 5.59 for the 21-level version and 11.32
for a coarse five-bucket one - so the finer resolution bought nothing and the
coarse variant was clearly worse). `PROMPT_VERSION` is now `v3`; v1 and v2
verdicts in `crashes.json` keep their old meaning.

Verified live afterwards, through `classifyError` with pi's stored TypeSafe
credential: quota -> `quota` + 1440 min for a message stating "in 1d 2h" (truth
26 h), 122.9 min for a 5 h window, 1.7 min for "retry after 30s"; 401 -> `auth`
and 503 -> `transient`, both with no reset. Local `tinyjev` classifies all five
correctly on the same rubric; `tev1:0.8b` gets the classes right but its reset
windows remain unreliable (two of five wrong), so it stays the weaker option.

## 2026-10-06 — Provider catalog derived from pi; no hardcoded ids, URLs or model ids

Two hardcoded tables were removed from `src/classifier-catalog.ts`:
`PRECONFIGURED_CATALOG_PROVIDERS` (five provider ids with display names and base
URLs restated from pi-ai's generated catalog) and `LOCAL_CLASSIFIER_ENDPOINTS`
(two local endpoints with provider ids, `OLLAMA_HOST` / `LLAMA_SERVER_URL`,
invented default addresses and a wire API). Three of the five base URLs I had
written were **wrong** - `opencode`, `cloudflare-workers-ai` and
`vercel-ai-gateway` all differed from pi-ai's data - which is exactly the
drift a duplicated catalog produces.

The catalog is now purely derived: `buildClassifierProviders` takes the
registry view the caller assembles (`getRegisteredProviderIds` →
`getProvider` → `getModelsOfType("classifier" | "chat", id)`) and turns it into
wizard choices - id, display name, base URL, classifier model ids and wire api
all from pi. `ClassifierProviderSource`/`buildClassifierProviders` are pure, so
the module has no knowledge of any vendor. Everything else follows:

- The wizard's provider list is pi's roster, i.e. whatever `/login` configured.
  **Switchback implements nothing for provider/model auth on the catalog path**:
  the config entry is `{provider, id}` and pi's `modelRegistry.classify()`
  resolves endpoint, api and credential.
- `RESERVED_CLASSIFIER_PROVIDER_IDS` (`new Set(["ollama"])`) is gone from the
  loader. The hazard it guarded - registering a classifier under a provider pi
  already serves chat models for makes pi replace those models
  (`applyExtension` returns `config.models.map(...)` whenever the extension sets
  `models`, confirmed in the running 1.0.4 bundle) - is now a **derived** rule in
  the wizard, where the registry is available: refuse when `chatModels > 0`.
  Whatever pi has models for is reserved, by definition.
- Live model discovery (`classifier-discovery.ts`, Ollama `/api/tags` filtered by
  the `decision` capability) is triggered by "the catalog knows no model ids for
  this provider and the endpoint is reachable", not by a hardcoded provider name.
- A catalog provider now writes **no** `baseUrl` (pi resolves it); only a direct
  endpoint does, and only that path uses switchback's own secret store.

`@earendil-works/pi-ai` and `pi-coding-agent` moved to `^1.0.4` (devDependencies;
peerDependencies `*`) per the standing "always latest" rule. Tests: the catalog
suite was rewritten against the pure function, and the wizard tests now cover
catalog-resolved vs direct-endpoint configuration. Commit: TBD.

Naming, settled by measurement rather than assumption: the local SystemOne
endpoint's provider id is **`ollama`**. Nothing on this machine registers that
id - pi 1.0.4's dist contains zero `ollama` strings, pi-ai 1.0.4 ships no ollama
provider or data file, and across every installed extension package the only
registered provider id is `ollama-cloud` (the `ollama` credential in `auth.json`
is stale). I had invented `ollama-systemone` and then `ollama-local` on the
assumption that a collision had to be dodged; the collision hazard is real but
name-independent, so no id needs reserving.

One endpoint, many models: registration used to be keyed on `provider|baseUrl`
and called once per distinct endpoint with a single `jev`, so a second decision
model on the same endpoint was never registered and classified as
`unresolvable` (live config had `tinyjev` and `tev1` both on `provider: ollama` +
`http://127.0.0.1:11434/v1`). `groupLocalEndpoints` now collects every model that
shares an endpoint - including `decisionModels` entries no virtual model
references, so an endpoint stays registered while a model list is edited - and
`registerLocalClassifier` takes the whole group, which is what pi needs since it
replaces a provider's model list wholesale. Verified against the live config:
one registration for `ollama` carrying both `parable/tinyjev:latest` and
`tev1:0.8b`.

## 2026-10-04 — agents-scaffold DOX framework install

Installed the [agents-scaffold](https://codeberg.org/jr2804/agents-scaffold)
DOX hierarchy: root `AGENTS.md` (template contract + 9 project rules) plus
`.agents/{ONBOARDING,POLICIES,FILES,HISTORY,MAINTENANCE}.md`. The `.gitignore`
was extended to track `.agents/*.md` and `.agents/history/` while keeping
`.agents/skills/` (machine-local) and `.agents/plans/` (mutable working
artifacts) ignored. Commit: (this commit — fill the hash on a follow-up
update if exact ref is required).

## 2026-10-04 — `switchback-2r8` closed (no-"heuristic-fallback" rule)

Eliminated the phrase "heuristic fallback" from the codebase and docs as a
deliberate anti-pattern next to the classifier-only architecture (per
`switchback-idu` findings). Tracked as `switchback-2r8` (P3, chore, docs+tests).

## 2026-10-04 — `switchback-idu` closed (`MIN_DWELL_MS` enforcement + decide() drift)

Closed the `MIN_DWELL_MS`-not-enforced gap and corrected the `decide()` docblock
to remove the false "success-unblock" claim. `decide()` now enforces
`MIN_DWELL_MS` (30s) for `user`/`direct` routing, reading `lastSwitchAtMs` from
the session branch state. Commits: `ce906a9` (fix), `251e2e8` (README delta).

## 2026-10-04 — Standing `bd dolt push` user approval

User granted standing approval for `bd dolt push` for all future calls.
Separate one-time approvals at the same time: fix `switchback-idu` and fold
`switchback-2r8` in.

## 2026-10-04 — README: single source of truth for the backlog

Replaced the stale "current open backlog" table in `README.md` with a pointer
to `bd list --all` / `bd show switchback-bqq` so the README cannot drift from
the board. Commit: `251e2e8`.

## 2026-10-06 — Classifier timeout doubled to 10 s for cold local models

`CLASSIFIER_TIMEOUT_MS` was 5 s, which was fine for a hosted classifier but
not for a local SystemOne model that Ollama has evicted: switchback's transport
sends no `keep_alive`, so Ollama unloads the model after its default 5-minute
idle, and the next classification has to read it back off disk first. Measured
on this host (Ollama v0.35.1, 2026-10-06):

| model | cold | warm |
|---|---|---|
| `parable/tinyjev:latest` (4.2B Q8_0, 4.3 GB) | 7.2-7.8 s | ~0.07 s |
| `tev1:0.8b` (774 MB) | 2.2-2.7 s | ~0.04 s |

A cold medium-sized model therefore blew the old budget and turned the first
failure after an idle gap into a spurious `no-classifier` blind cycle — with
no indication that the model was simply still loading. 10 s covers it; warm
calls stay far inside, so the headroom costs nothing in the common case. The
`systemone.ts` request timeout (30 s) is unaffected and still bounds the fetch.

One test consequence: `router.test.ts`'s "classifier times out" case used to
lean on the default budget and took 10 s of wall clock. It now drives
`callClassifier` with an explicit 50 ms budget — the same race, instantly —
while `classifyError`'s forwarding of a tagged `no-classifier` stays covered by
the `threw` / `unresolvable` cases. Commit: TBD.

## 2026-10-06 — Reset window: SystemOne `score` is a rubric index, not 0-100

The `reset` question asked for "a score 0-100" on a five-level rubric, and
`scoreToResetAtMs` mapped the answer on a 0-100 scale (`(score-50)` hours,
`(score-75)` days). Both SystemOne backends define a `score` answer as the
probability-weighted average of the rubric **level indices** — Ollama
(`docs.ollama.com/api/systemone`: "from 0 to the number of criteria minus 1";
three criteria -> "on the 0-2 scale") and TypeSafe
(`api.typesafe.ai/openapi.json`: "the probability-weighted average of the rubric
levels", example `1.7`) — and pi-ai forwards the number verbatim
(`dist/api/system-one-shared.js`). So v1's five-level rubric could only ever
return `[0, 4]`, and every real reset window collapsed to a few seconds.

Verified live against `tev1:0.8b` (pulled for this work): a five-level rubric
plus "Try again in 1d 2h" answers `score: 0.914` with `legend` echoing the
levels and `probabilities {0: 0.68, 1: 0.04, 2: 0.07, 3: 0.10, 4: 0.11}` —
`0.914` is exactly the weighted index average. v1 read that as ~1 second; the
message states 26 hours.

v2 replaces the question with `RESET_RUBRIC`: a 21-level, roughly logarithmic
ladder from "no reset time" through seconds to a month, where the index *is*
the answer and the table maps it back to a duration (geometric interpolation
between levels, 31-day cap). `PROMPT_VERSION` is now `"v2"`. The probe's score
question and validation were fixed the same way (rubric extent, not 0..100).

Level count was chosen on measurement, not taste: against `tev1:0.8b` a
5-level bucket rubric (the literal reading of "one level per bucket") puts
placement 11.3 bits (log2) from the true wait, a 9-level ladder 5.8, the
shipped 21-level ladder 5.6. 5 levels measured worst, so the finer ladder
stands. The same model systematically under-estimates (1d 2h -> 2.1h), which is
a model-quality limit, not a mapping bug: the 4B `tev1` or `nimble` places
better. An example-anchored instruction variant measured 5.05 bits vs 5.59 —
within noise, so the simpler instruction was kept.

Also verified the `tev1` naming trap: the live config's `id: tev` was a
hand-built Modelfile over the experimental Tev1-4B GGUF (3.47 GB,
`capabilities: [tools, thinking, completion, vision]`), so Ollama answered
`400 ... does not support decision`. The official library model is `tev1`
(`ollama pull tev1` / `tev1:0.8b`, 812 MB). The live config now points at
`tev1:0.8b`.

AGENTS.md rule 5 was reworded: "parseable reset durations from the error
message" describes the classifier's *input*, not code-side parsing, so it never
contradicted rule 1's ban on regex extractors. Commit: TBD.

## 2026-10-06 — Decision-model wiring overhaul

Four bugs in the decision-model surface, surfaced by `crashes.json` and the
wizard:

- The local Ollama endpoint's provider id collided with a pi chat provider:
  `registerProvider(id, {models:[classifier]})` makes pi replace that provider's
  model list with the classifier alone (pi's `applyExtension` returns
  `config.models.map(...)` whenever the extension sets `models`, confirmed in the
  running bundle). I first dodged it by naming the endpoint `ollama-systemone` and
  rejecting `provider: ollama` in the loader; **both were wrong and are
  superseded** by the entry above - nothing on this machine registers `ollama`, so
  that is the id, and the hazard is guarded by a derived check instead of a
  reserved name. See "Provider catalog derived from pi".
- `decisionModels` could be defined with no referencing model, leaving the
  router without a classifier for any error (`not-configured` → blind-cycle).
  Loader now rejects the case where **every** entry is unreferenced;
  partial references are allowed.
- The decision-model wizard's `name` was the first step (and free text),
  with `provider`, `baseUrl`, and `apiKey` after. Reordered to
  `provider → baseUrl → modelId → apiKey → name (LAST, prefilled)` and the
  name arrives as `<provider>-<model>`, `Enter` keeps it. The secret-store
  entry name follows the decision-model name (`secret:dm2-key`), so a
  re-key lands on the same row.
- The provider picker was a flat list mixing catalog typesafe/openrouter
  with local ollama/llama.cpp, with no distinction. Now grouped: catalog
  providers (`typesafe`, `openrouter`, `opencode`, `cloudflare-workers-ai`,
  `vercel-ai-gateway` — all always preconfigured) vs local SystemOne
  endpoints, plus "Other" for free text.
- For the local Ollama endpoint the model picker now queries `/api/tags`
  and filters by the `"decision"` capability (`src/classifier-discovery.ts`,
  `tests/classifier-discovery.test.ts`), surfacing the SystemOne-capable
  models actually on the user's machine. A model without that capability
  still surfaces at the wire level as 400 `does not support decision`
  (`docs/configuration-dialogue.md`, `docs/configuration.md` updated to
  describe the new order and the orphan check).
- The user's chosen id `tev` (per the 2026-10-06 directive) is empirically
  rejected by Ollama v0.35.1: `400 {"error":"registry.ollama.ai/library/tev:latest
  does not support decision"}`. The id was kept verbatim in the live config
  per the user's instruction; the empirical failure now shows up in
  classifyError rather than being hidden. `nimble:latest` is the only model
  in this host's `/api/tags` with the `"decision"` capability; switching
  the id is a one-line edit when the user wants the failure to disappear.

Live config `~/.pi/agent/switchback.yaml` updated. Sub-beads:
`switchback-ab3.1` (orphan check), `switchback-ab3.2` (provider rename),
`switchback-ab3.3` (live config). Depends on `switchback-fs9`. Commit: TBD.

## 2026-10-04 — Classifier-only error classification (locked)

Locked the architecture: every message-derived classification decision comes
from the configured SystemOne classifier (`ctx.modelRegistry.classify`). No
keyword sets, no HTTP-code patterns, no regex reset extractors. The Jev prompt
v1 is LOCKED against 41 passively-collected real error samples; the 42nd
(deliberate zai 401 probe, captured 2026-10-04) is pending live Jev
validation. The repo ships 9 fixture scenarios in `switchback.simulate.json`
representing the distinct shapes observed. Commit: `4915e34` (initial release).
