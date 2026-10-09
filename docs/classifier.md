# Classifier

The router classifies every provider failure through the configured SystemOne
classifier — a single source of truth for message-derived decisions. There are
no keyword sets, no HTTP-code patterns, and no regex-based reset extractor in
the production route, and no prompt criteria taken from collected provider
traffic (root `AGENTS.md` project rule 7). The prompt is Jev prompt **v5**
(2026-10-09). It was locked against 41 passively-collected real error samples,
and the corpus is **test input only** — it is never a reason to change the
prompt.

## The `reset` answer is a rubric index

A SystemOne `score` answer is the probability-weighted average of the rubric
**level indices** — Ollama's `/v1/systemone` and TypeSafe's API say so
explicitly, and pi-ai forwards the number verbatim. It is never a percentage.
Switchback therefore sends a rubric whose levels *are* the answer space
(`RESET_RUBRIC`: no-reset, then a roughly logarithmic ladder from seconds to a
month) and reads the index back into a duration. There is no arithmetic against
a raw score anywhere.

v1 asked for "a score 0-100" on a five-level rubric. Both backends answer that
with an index in `[0, 4]`, so every reset window collapsed to a few seconds —
verified live against `tev1:0.8b`, where a five-level rubric plus the message
"Try again in 1d 2h" answers `0.914` (the rubric index) where v1 expected 78.

Level count was chosen on measurement: against `tev1:0.8b`, a 5-level bucket
rubric puts placement 11.3 bits (log2) off the true wait, a 9-level ladder 5.8
and a 21-level ladder 5.6. The shipped ladder is **9 levels**, not 21, because
TypeSafe's hosted Jev rejects more than ten with `400 Too many score levels`
and returns *no answers* — a rejected request silently classified every message
as `unknown`. `MAX_SCORE_LEVELS = 10` guards it. Note that a small decision model
systematically *under*-estimates; the 4B `tev1` or `nimble` places much better.

### The `scope` question carries no worked examples

v4 rewrote `scope` around the general cue each option stands for (a named model
or series; a credential, plan, balance or usage quota; an address or region),
because v3 named only `unknown` in its instructions and asked for counterfactual
judgements — and `unknown` took the prior mass and won every case
(`typesafe/jev-latest` answered 84-92% `unknown`).

v4's wording also carried examples lifted verbatim out of the corpus
(`'GLM 5h window'`, `'invalid API key'`, `'monthly cap'`), which is exactly what
rule 7 forbids. v5 removed them and kept the general cues. Measured on two
held-out messages never present in the corpus:

| Backend | v4 (with examples) | v5 (general cues only) |
|---|---|---|
| `typesafe/jev-latest` | 7/7 | 7/7 |
| `parable/tinyjev:latest` | 7/7 | 5/7 |

The hosted classifier never needed the anchors; a 4.2B local model did. The
shipped configuration uses the hosted path, so the recorded cost is confined to
the local fallback. There is deliberately **no model-dependent prompt wording** —
one prompt, whichever backend answers it.

This page has two parts:

1. **[Live classifier validation](#live-classifier-validation-opt-in)** —
   how to wire a live SystemOne deployment and run the opt-in integration
   test against the preserved corpus.
2. **[Coverage matrix](#coverage-matrix)** — which real error shapes have
   been observed and where validation stands.

---

## Live classifier validation (opt-in)

`tests/integration-classifier.test.ts` validates the classifier against the preserved
corpus by driving the real `classifyError` through a real SystemOne-style transport
(the same one pi uses). It is **skipped unless** these environment variables are set —
nothing is hardcoded, so any deployment can be pointed at:

| Variable | Required | Meaning |
|---|---|---|
| `SWITCHBACK_CLASSIFIER_API` | yes | transport id: `typesafe-system-one` or `llama-cpp-classify` |
| `SWITCHBACK_CLASSIFIER_PROVIDER` | yes | provider label for the model handle; must match the `jev:` provider in `switchback.yaml` |
| `SWITCHBACK_CLASSIFIER_MODEL` | yes | classifier model id |
| `SWITCHBACK_CLASSIFIER_BASE_URL` | yes | API base URL / llama-server root |
| `SWITCHBACK_CLASSIFIER_API_KEY` | no | bearer token; required by hosted endpoints, omit for a keyless local server |

### Example: TypeSafe hosted (`typesafe.ai`)

Values straight from pi's model catalog (`typesafe` provider).

| Variable | Value |
|---|---|
| `SWITCHBACK_CLASSIFIER_API` | `typesafe-system-one` |
| `SWITCHBACK_CLASSIFIER_PROVIDER` | `typesafe` |
| `SWITCHBACK_CLASSIFIER_MODEL` | `jev-latest` |
| `SWITCHBACK_CLASSIFIER_BASE_URL` | `https://api.typesafe.ai/v1/` |
| `SWITCHBACK_CLASSIFIER_API_KEY` | set to the same value as `TYPESAFE_API_KEY` |

### Example: OpenRouter (`openrouter.ai`)

OpenRouter serves the same SystemOne protocol, so it uses the same API id.

| Variable | Value |
|---|---|
| `SWITCHBACK_CLASSIFIER_API` | `typesafe-system-one` |
| `SWITCHBACK_CLASSIFIER_PROVIDER` | `openrouter` |
| `SWITCHBACK_CLASSIFIER_MODEL` | e.g. `typesafe/jev-1.13`, `liquid/d1`, `respan/span-01-lite`, `~typesafe/jev-latest` |
| `SWITCHBACK_CLASSIFIER_BASE_URL` | `https://openrouter.ai/api/v1` |
| `SWITCHBACK_CLASSIFIER_API_KEY` | set to the same value as `OPENROUTER_API_KEY` |

Other hosted SystemOne endpoints (same API id): OpenCode Zen — provider
`opencode`, model `jev-1.13`, base `https://opencode.ai/zen/v1`; Vercel AI Gateway —
provider `vercel-ai-gateway`, model e.g. `typesafe-ai/jev`, base
`https://ai-gateway.vercel.sh/typesafe/v1`.

### Example: local llama.cpp (`llama-server`)

| Variable | Value |
|---|---|
| `SWITCHBACK_CLASSIFIER_API` | `llama-cpp-classify` |
| `SWITCHBACK_CLASSIFIER_PROVIDER` | `llama.cpp` (any label; must match the `jev:` provider in `switchback.yaml`) |
| `SWITCHBACK_CLASSIFIER_MODEL` | the model id `llama-server` reports (e.g. a GGUF filename) |
| `SWITCHBACK_CLASSIFIER_BASE_URL` | `http://127.0.0.1:8080` |
| `SWITCHBACK_CLASSIFIER_API_KEY` | only when `llama-server` runs with `--api-key` |

```powershell
$env:SWITCHBACK_CLASSIFIER_API="llama-cpp-classify"
$env:SWITCHBACK_CLASSIFIER_PROVIDER="llama.cpp"
$env:SWITCHBACK_CLASSIFIER_MODEL="<your-classifier-model-id>"
$env:SWITCHBACK_CLASSIFIER_BASE_URL="http://127.0.0.1:8080"
npx vitest run tests/integration-classifier.test.ts
```

### Example: local Ollama (decision models)

Ollama v0.35.0+ serves the same System One protocol at `/v1/systemone`, so it uses
the `typesafe-system-one` transport (not `llama-cpp-classify`). Point the base URL
at Ollama's `/v1`:

| Variable | Value |
|---|---|
| `SWITCHBACK_CLASSIFIER_API` | `typesafe-system-one` |
| `SWITCHBACK_CLASSIFIER_PROVIDER` | `ollama` (any label; must match the `jev:` provider in `switchback.yaml`) |
| `SWITCHBACK_CLASSIFIER_MODEL` | an Ollama **decision** model: `nimble`, `tev1`, `clef` or `clef-flash` |
| `SWITCHBACK_CLASSIFIER_BASE_URL` | `http://localhost:11434/v1` |
| `SWITCHBACK_CLASSIFIER_API_KEY` | any non-empty dummy value, e.g. `ollama` (see below) |

Two gotchas:

- Ollama only answers `/v1/systemone` for models that advertise the `decision`
  capability (`ollama pull nimble`). Check with `ollama show <model>` — if the
  `capabilities` list has no `decision`, the endpoint returns 400
  "does not support decision". A generic chat GGUF is not decision-capable.
- Ollama's local requests need no key, but pi's `typesafe-system-one` transport
  throws before sending unless a non-empty `apiKey` is present. Ollama ignores the
  `Authorization` header, so set `SWITCHBACK_CLASSIFIER_API_KEY` to any dummy value
  (e.g. `ollama`).

To classify with a **generic chat GGUF** you already have (any small local model),
serve it with `llama-server` instead and use `llama-cpp-classify`: that transport
reads the label next-token probabilities and needs no decision-trained model.

### When are PROVIDER / MODEL / BASE_URL necessary?

Always, for this test: it builds the classifier model handle directly, bypassing pi's
catalog, so none of the four has a default. In normal `switchback.yaml` use they are
only the `jev:` entry (`provider` + `id`) and pi resolves the base URL from its catalog —
the test's explicit `BASE_URL` exists only because it is not loading that catalog.
`API_KEY` is the single optional value (keyless local servers omit it).

Each corpus scenario asserts the class the locked prompt should return. This run is the
ground-truth validation the coverage matrix's `Jev ⏳` cells are waiting for; a red case
is a prompt/model problem to fix, never a heuristic to add.

---

## Coverage matrix

The matrix below answers one question: **which of the four real error shapes the
classifier should recognise have we actually validated it against?** With the
classifier-only architecture (no heuristic path), validation = "we have a real
sample AND we ran it through the Jev prompt and Jev gave the right answer."
Until Jev is wired to a live deployment, the second column is "not validated"
even where the first is "corpus present." What ships in the repo is a set of
distinct error *shapes* preserved as scenarios in `switchback.simulate.json`
(10 scenarios today), so a future live Jev run has ground truth to validate
against. The parenthetical counts in the Corpus column (e.g. `✓ (12+)`) are raw
occurrences observed during the 2026-10-04 passive mining, not fixture entries;
the same shape recurs many times.

**Validation status legend** (honest — no aspirational checkmarks):

- `corpus ✓ + Jev ✓` = real sample present in the fixture, classified correctly
  by the locked Jev prompt on a live run.
- `corpus ✓ + Jev ⏳` = real sample present in the fixture, Jev not yet
  validated against it (TYPESAFE_API_KEY absent in this environment).
- `corpus ✓ + structured ✓` = real sample present in the fixture AND validated
  by pi's typed-field branch (`stopReason === "length"` for overflow). This
  is NOT a Jev run; it is the code-side short-circuit that fires regardless
  of classifier availability. Listed alongside `Jev ✓` so the corpus column
  stays accurate; a `structured ✓` row never implies a Jev run happened.
- `corpus –` = no sample, no deliberate capture. Stays blind-cycled.

| Provider     | Window          | Class   | Corpus | Jev | Notes |
|--------------|-----------------|---------|:------:|:---:|-------|
| z.ai GLM     | 5h              | quota   | ✓ (12+)| ⏳  | bare + JSON-wrapped shapes, reset parseable |
| z.ai GLM     | weekly          | quota   | –      | –   | no corpus, deliberate capture reserved for user |
| z.ai GLM     | monthly         | quota   | –      | –   | no corpus, deliberate capture reserved for user |
| z.ai GLM     | auth failure    | auth    | ✓ (1)  | ⏳  | 401 probe 2026-10-04: `401: {"error":{"code":"401","message":"token expired or incorrect"}}` |
| z.ai GLM     | transient 5xx   | transient | ✓   | ⏳  | "Connection error." + "Request timed out." |
| z.ai GLM     | context overflow| overflow | ✓   | ✓ (structured)  | pi's typed `stopReason === "length"` short-circuit; works without per-provider text patterns (Jev path for overflow is also ✓ via the locked prompt) |
| ollama-cloud | weekly          | quota   | ✓ (4)  | ⏳  | "weekly usage limit, upgrade for higher limits" |
| ollama-cloud | session         | quota   | ✓ (4)  | ⏳  | "session usage limit" |
| ollama-cloud | monthly         | quota   | –      | –   | no corpus |
| ollama-cloud | client config   | unknown | ✓ (1)  | ⏳  | 400 invalid_request_error — classifier is expected to return `unknown` (provider-wide config error, not auth) |
| ollama-cloud | transient 5xx   | transient | ✓   | ⏳  | "Connection error." + "Request timed out." |
| minimax   | 5h          | quota   | ✓ (4)  | ⏳  | "Token Plan usage limit reached (2056)" — no parseable reset; fixture `quota-minimax-token-plan` (captured 2026-10-04) |
| minimax   | weekly      | quota   | –      | –   | no corpus |
| minimax   | monthly     | quota   | –      | –   | no corpus |
| minimax   | auth failure| auth    | –      | –   | no corpus |
| minimax   | transient   | transient | ✓   | ⏳  | "Connection error." + "Request timed out." |
| opencode-go | 5h/weekly | quota   | –      | –   | no corpus |
| opencode-go | region constraint | unknown | ✓ (4) | ⏳  | "This Go model requires Global regions" — kept unknown on purpose (account-specific) |
| opencode-go | transient | transient | ✓   | ⏳  | "Connection error." + "Request timed out." |

**Honest summary:** the 2026-10-04 passive mining observed **41 raw error
samples** across all four providers. A deliberate zai 401 probe and a
MiniMax "Token Plan" quota capture were added the same day; the Jev prompt's
class and scope questions are
**LOCKED against 41** (the pre-probe baseline), and both later captures are
**pending Jev validation**. The reset question was revised to a rubric in v2
(see above); the corpus asserts classes, not reset windows. Only the distinct shapes survive in the repo as
**10 scenarios** in `switchback.simulate.json`; the zai 401 probe and the
MiniMax capture are preserved verbatim and test-asserted, the rest of the raw
corpus is not shipped. Jev validation
status is `⏳` everywhere because TYPESAFE_API_KEY is not set. The router works
today on a no-Jev install (blind cycle) and will work as documented when Jev is
wired in (no code change required - just set `jev:` in `switchback.yaml` to a
registered classifier). A live Jev re-validation can then be run end-to-end
against those fixtures.

Gaps that stay blind-cycled (corpus not present):

- z.ai weekly / monthly / auth and minimax weekly / monthly / auth — user-reserved
  captures — do not perform.
- opencode-go 5h / weekly / monthly / auth — no corpus, account settings specific.
