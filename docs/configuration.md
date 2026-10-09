# Configuration

Prefer not to hand-edit? `/switchback-config` walks the same file through menus
and prompts — see the [configuration dialogue](configuration-dialogue.md).

## File format map

The project uses four files with four distinct roles and formats. **The two
runtime files (`blocks.json` and `crashes.json`) live under the agent config
dir (`<piConfigDir>/switchback/`)** — not the project dir — because blocks and
crashes are account-scoped, not project-scoped. The legacy location
`<cwd>/.pi/switchback.json` is auto-migrated on first read (per-key max
timestamp wins) and then deleted.

| File | Format | Role | Owned by | Location |
|---|---|---|---|---|
| `switchback.yaml` | YAML | Human config: fallback list, optional Jev classifier. Per-project override or `~/.pi/agent/`. | user | `<cwd>/.pi/` or agent dir |
| `blocks.json` | JSON | Runtime blocked-until map (atomic write, lazy prune). Created on first block. Migrated from the legacy `<cwd>/.pi/switchback.json` path on first read. | switchback | `<piConfigDir>/switchback/` |
| `crashes.json` | JSON | Runtime crash dedup store: sha256(raw) → entry. Created on first failure. User annotations become the Tier 2b cache. | switchback | `<piConfigDir>/switchback/` |
| `switchback.simulate.json` | JSON | Synthetic error scenarios. Now used by router tests + the opt-in live integration test; the user-facing simulate command was removed. | switchback | repo (cwd) |

The YAML-only rule applies to **user config** only. JSON stays for files that
are written by the runtime or used as read-only fixtures; switchback never
parses a user-supplied JSON config.

## Config layers and aggregation

Two optional user layers exist:

1. `<cwd>/.pi/switchback.yaml` (per-project layer)
2. `~/.pi/agent/switchback.yaml` (global layer)

With neither present, the built-in `DEFAULT_CONFIG` (empty fallback list —
surfaces a `ConfigError` pointing the user at this section; see below) applies.

The layers are **aggregated**, not first-match-wins: the merged model list is
the global list with per-project entries overriding same-id entries **in
place**, and project-only models appended after the global ones in project
order. A duplicated model id therefore means the project entry wins wholesale
— fallbacks, name and classifier — with no field-level merging.

The project-local slot lives under `.pi/` deliberately: git ignores that
directory (pi's own convention), so a per-project override can never be
committed into a repository the way a repo-root `switchback.yaml` would be.
The repo ships only `switchback.yaml.example` as the template. The base config
therefore belongs in the global file, and the project file carries only the
overrides for one directory — `/switchback-config` asks which layer to edit
before anything else and shows both files with their current contents, so an
edit never lands in the wrong one by accident (see
[Configuration dialogue](configuration-dialogue.md)). Practically:

- **Inside a project with a `.pi/switchback.yaml`**: that layer is merged on
  top of the global one (or stands alone if no global copy exists).
- **Anywhere else**: the global copy is used verbatim.

A layer that exists but fails to parse or validate throws immediately — a
broken layer is surfaced, never silently dropped in favour of the other.

## Diagnostics (`debug`)

A top-level boolean emits one notification per model switch, so a live session
shows what the router did instead of only the (quiet) success cases:

```yaml
debug: true
```

Each switch line names the models involved, the decision reason (which for a
blocked path includes the classifier's verdict and its reset window) and how
the requested reasoning category resolved against the model that is about to
serve the request - including the classifier's confidence and the levels that
model supports. The `SWITCHBACK_DEBUG=1` environment variable overrides the
config entry, so a session can be diagnosed without a config edit:

```bash
SWITCHBACK_DEBUG=1 pi --model switchback/auto
```

With the flag off (the default) switches are silent; the no-classifier warning
is always shown, regardless of this flag.

## `DEFAULT_CONFIG` and the empty-fallbacks design

`DEFAULT_CONFIG` ships with `fallbacks: []`. This is intentional: if a user
has neither a project-local copy nor an agent-dir copy, the router should fail loudly
with a clear `ConfigError` ("no fallbacks configured") rather than silently
fall through to a placeholder that may or may not exist in the catalog at
any given moment.

`switchback.yaml.example` carries the 4-provider fallback list as the
template; a copy of it at `<project>/.pi/switchback.yaml` or
`~/.pi/agent/switchback.yaml` is what fills `DEFAULT_CONFIG` in practice. It
contains only model ids and a classifier reference — no API keys, no
tokens, no account identifiers. Credentials are read from environment
variables by pi itself, not by switchback.

## Greyed-out entries and auto-recovery

If a configured id stops resolving in the catalog (model retired, provider
disappears, credentials unconfigured), `resolveFallbacks()` marks it
`greyed-model-not-in-catalog` or `greyed-provider-unavailable` and the router
skips it on the next route call. The config file is left untouched.

Re-evaluation happens on every route call — there is no caching. The moment a
greyed entry reappears in the catalog (e.g. the user re-enables credentials
or the provider comes back), it becomes effective again with no config edit.
The `/switchback` status command shows which entries are greyed, with the
reason.

## Context window on a switch

pi sizes the conversation against the model a request is routed to: for a
virtual selection the compaction threshold is checked with the **routed**
model's `contextWindow`, and the status bar follows it too. Moving to a model
with a smaller window than the current context therefore triggers compaction
right after the hop — the conversation gets summarized for no reason other than
the switch.

When a model fails and the router has to choose a replacement, it **prefers** a
candidate that can hold the current context (the size pi reports, minus a
response reserve) over one that cannot:

- It is a **preference, never a filter**. A model is never made ineligible.
- If **nothing** can hold the context, the ordinary preference order still wins —
  keeping the session alive matters more than avoiding a context drop, and
  compaction is pi's own, correct behaviour in that case.
- It only runs while the router is **already looking for a new model**
  (a failover switch or an idle reset). A sticky session is never re-routed,
  however large its context.
- When pi cannot report a context size, no preference is applied.
- When **more than one** candidate can hold the conversation, the **decision
  model chooses between them**: it is given the context size, each candidate's
  window and remaining headroom, the model that just failed and your own
  preference order, and may reorder them. The deterministic pick stays the floor —
  an absent, failed or unreadable answer keeps it — so this can only reorder
  candidates that were already eligible, never introduce one.

The margin is `CONTEXT_FIT_RESERVE_TOKENS` (16k, pi's own default compaction
reserve), so a model that only just fits is not treated as fitting — it would
compact immediately after the switch.

## Idle reset (`idleReset`)

A session is sticky on purpose: staying on the model it is already using keeps
the provider's prompt cache and thinking signature valid. After a long idle
period that reasoning stops holding — the cache is gone, so staying costs the
same as switching. And because a model with a short quota window and no weekly
cap (z.ai's 5h window, for example) "respawns" quickly, going back to the first
entry of the list can be the more efficient choice.

`idleReset:` is set per virtual model and takes one of:

| Value | Behaviour |
|---|---|
| `never` (default) | Always stay on the current model, however long the idle gap. |
| `30m`, `1h`, `2h`, `3h`, `5h`, `12h`, `24h` | Once the session has been idle at least that long, the next `user`/`direct` request returns to the first usable entry of the fallback list. |
| `classifier` | Ask the decision model whether returning is worthwhile. |

```yaml
models:
  - id: auto
    fallbacks: ["zai/glm-5.3", "ollama-cloud/glm-5.3-flash"]
    idleReset: 5h        # spend the short-window quota first after a long gap
```

Details worth knowing:

- **Idle time comes from the conversation.** It is measured from the newest
  message in the request to now, so no state file or bookkeeping is involved.
- **A pin outranks it.** `/switchback-next` is an explicit "route here" and is
  honoured whatever `idleReset` says.
- **`classifier` has a floor.** Below 30 minutes the decision model is not
  asked at all — the answer would always be "stay" and the call would be pure
  latency on a live session. When the classifier is unavailable (missing,
  unresolvable, timeout, threw, unparseable) the session keeps its current
  model: unlike error classification this is a preference, so the conservative
  outcome is to change nothing.
- **Only `user`/`direct` routes are affected.** Continuations, retries and
  overflow stickiness keep their existing behaviour, which is what preserves the
  cache while a conversation is actually running.
- **Blocked entries are skipped.** The reset picks the first *usable* entry, so a
  head model that is quota-blocked is passed over until its reset time.

With `debug: true` the reset reports itself:
`idle-reset-threshold: idle 6h >= 5h` or
`idle-reset-classifier: idle 8h, classifier says return to zai/glm-5.3`.

## Classifier (`jev:`)

The `jev:` entry names a classifier model and (optionally) tells switchback
to register that provider itself. With `baseUrl` present, switchback
registers the provider through pi-ai's `typesafe-system-one` transport, so
a local SystemOne server needs no pi provider and no `models.json` entry.
This is the only supported way to run switchback against a local decision
model.

Fields (all optional, except where noted):

- `baseUrl` — presence switches to "register this endpoint ourselves".
  `http(s)` URL.
- `api` — wire API; only `typesafe-system-one` is accepted today. Requires
  `baseUrl`.
- `apiKey` — bearer token. Local servers ignore it, but the transport
  refuses to send without one, so it defaults to the provider name.

Omitting `baseUrl` keeps the catalog behaviour: the classifier is looked up
in pi's catalog from `provider` + `id` only, and **pi supplies the endpoint,
the wire API and the credential** — whatever `/login` or the provider's
environment variable configured. Switchback stores nothing and asks for
nothing on this path.

A `baseUrl` therefore marks a *direct* endpoint: one pi has no catalog entry
for (a local Ollama server, a self-hosted gateway). Switchback registers the
classifier itself from the config, and this is the only case that needs a
switchback-side credential (`apiKey` / `secret:<name>`).

Several decision models may share one endpoint. They are registered together in
a single provider declaration, because pi replaces a provider's whole model list
when an extension supplies one — a model left out of that call would be invisible
to the registry and classify as `unresolvable`. Decision models that no virtual
model currently references are registered too, so an endpoint stays available
while a model list is being edited.

The wizard refuses to write a direct endpoint under a provider id pi already
serves chat models for: registering a classifier there would make pi replace
those models (its `applyExtension` returns `config.models.map(...)` whenever an
extension sets `models`). The check is derived from the registry - whatever pi
has models for is reserved, by definition - not from a list of names, and it
reads:

```text
pi already serves 7 chat model(s) under "<provider>". A direct endpoint here
would replace them with the classifier alone - pick a distinct provider id
("<provider>-<suffix>") instead.
```

A `decisionModels:` block whose entries are not referenced by **any**
`models[].jev.decisionModel` is a startup error too: every entry becomes an
orphan, the router sees no classifier, and every error is reported as
`not-configured`. Partial references (some entries referenced, others not)
are allowed: keep the unreferenced ones around to wire up later, the loader
does not complain. An orphan-everything error names every unreferenced
entry in one go.

Example — pi's own catalog (no endpoint, no key in the config):

```yaml
models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - zai/glm-5.3
    jev:
      provider: typesafe
      id: jev-latest
```

Example — a direct endpoint pi does not know (Ollama v0.35+):

```yaml
models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - ollama/minimax-m3
    jev:
      provider: ollama
      id: tev1:0.8b
      baseUrl: http://localhost:11434/v1
      api: typesafe-system-one
      apiKey: ollama
```

Notes:

- Ollama decision-capability gotcha: see [Classifier → Example: local Ollama](classifier.md#example-local-ollama-decision-models).
- For the env-var-driven test path against a live classifier (TypeSafe
  hosted / OpenRouter / llama.cpp / Ollama), see
  [Classifier → Live classifier validation](classifier.md#live-classifier-validation-opt-in).

## Encrypted API-key store (`secret:<name>`)

A credential never lives in YAML: a classifier `apiKey` may reference a named
secret instead of a literal value.

```yaml
decisionModels:
  - name: hosted
    provider: my-provider
    id: my-model
    baseUrl: https://example.invalid/v1
    apiKey: secret:my-provider-key
```

The value itself lives in `<piConfigDir>/switchback/secrets.json`, encrypted at
rest with Windows DPAPI (CurrentUser scope): the file holds only DPAPI blobs,
decryptable by the Windows account that wrote them and by no other account on
the machine. There is no passphrase to choose or store, and no unencrypted
fallback — anywhere DPAPI is unavailable (a non-Windows host), reading or
writing a secret fails loudly instead of touching the key in clear text.

The file is machine-managed (atomic writes, never hand-edited). A file that
can't be read at all is quarantined to `secrets.json.corrupt.<ts>` and the
store starts empty; a readable file written by a different store version is
refused and left untouched. Secret values are held only in memory or as
encrypted blobs — never printed, logged, or written anywhere else — and
listing exposes names only.
