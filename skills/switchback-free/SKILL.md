---
name: switchback-free
description: >-
  Add or update a virtual model (default: sb-free) in switchback whose fallback
  list contains only free models from openrouter.ai, opencode.ai, and
  nousresearch.com. Use when the user asks to add/update a free-model virtual
  model, refresh sb-free, or remove stale hardcoded free-model names. Each
  provider has its own reference file in references/.
---

# switchback-free

Add or update a `sb-free` virtual model in `switchback.yaml` whose fallback
list contains only verified free models.

## Workflow

1. **Check active providers** — Determine which providers are configured in
   the user's pi/opencode setup. Only query providers that are actually active.
   See each provider's reference file for how to check.

2. **Query model lists** — For each active provider, fetch its model list using
   the method documented in its reference file.

3. **Identify free models** — A model is considered free if:
   - Its name ends with `:free` or `-free` (e.g. `meta-llama/llama-3.1-8b-instruct:free`,
     `google/gemini-2.0-flash-exp:free`), **or**
   - It appears in the provider's known-free-names list (e.g. `big-pickle` on
     opencode.ai, `opencode/big-pickle` — no suffix but always free).

   Always prefer live model-list data over hardcoded names. The hardcoded lists
   in the reference files are fallbacks for special cases that don't follow the
   suffix convention.

4. **Verify models** — For each candidate free model, confirm it appears in the
   provider's model list response. We check the model-list endpoint rather than
   making a full API call because a real API call conflates too many failure
   modes (invalid/deprecated model, connection failure, auth error, quota
   exceeded) — a model-list hit is a reliable signal that the model exists and
   is reachable at query time. This means a model can pass verification but
   still fail at inference time if it's since been removed or is temporarily
   down; that's acceptable because the fallback list is re-queried on every run.

5. **Clean stale names** — Compare the current `sb-free` fallback list against
   the verified live list. Any hardcoded name that no longer appears in the
   provider's model list is stale: remove it and recommend the user file an
   issue at the provider or upstream. A model that still resolves but has
   become unreliable or poor quality is a different case: keep it in the list
   and suggest the user disable it by hand (`/switchback-disable
   <provider/model>` in pi or the OpenCode plugin), which persists in
   `disabled.json` and survives this skill rewriting the fallback list.

6. **Write config** — Update `switchback.yaml` with the `sb-free` virtual
   model containing the verified free-model fallback list, sorted
   deterministically (alphabetical by provider, then by model name).

   **Config location precedence** (all aggregated, lowest → highest):
   1. `~/.config/switchback/switchback.yaml` — neutral basis (agent-agnostic)
   2. `~/.pi/agent/switchback.yaml` — agent overlay (shared by pi and the
      OpenCode plugin)
   3. `<cwd>/.pi/switchback.yaml` — local override

   Write to the highest-precedence location that already exists, or to
   `~/.config/switchback/switchback.yaml` if none exist yet.

   A chain names its classifier by address in `decisionModel:` (for example
   `decisionModel: typesafe/jev-latest` or `decisionModel: ollama/tev1:0.8b`);
   connection details, when not resolved from the classifier catalog, live in
   the top-level `decisionModels:` map keyed by that same address. There is no
   `jev:` block. See `docs/configuration.md` → Decision model.

## Adding a new provider

1. Create `references/<provider-name>.md` with:
   - How to check if the provider is active in pi/opencode
   - How to query its model list (endpoint or CLI command)
   - Known free-model suffixes or special-case names
2. Add a row to the provider table in this file (SKILL.md).
3. Update the workflow step 1 to reference the new provider.

## Provider reference files

| Provider                    | Reference file                          |
| --------------------------- | --------------------------------------- |
| openrouter.ai               | `references/openrouter.md`              |
| opencode.ai (opencode, opencode-go) | `references/opencode-ai.md`     |
| nousresearch.com            | `references/nousresearch.md`            |

## Verification approach — why model-list only

We verify free models by checking that the provider's model-list endpoint
returns the model successfully, rather than making a full inference API call.
A full API call would conflate invalid/deprecated models, connection failures,
authentication errors, and quota exhaustion — all of which return different error
codes that would require brittle error-classification logic. A model-list hit
is a reliable signal that the model existed and was reachable at query time.
The trade-off is that a model can pass verification but fail at inference time
if it's been removed or is temporarily down between runs; this is acceptable
because the fallback list is re-queried every time the skill runs, so stale
entries are cleaned up on the next invocation.
