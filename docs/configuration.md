# Configuration

Prefer not to hand-edit? `/switchback-config` walks the same file through menus
and prompts — see the [configuration dialogue](configuration-dialogue.md).

## File format map

The project uses five files with distinct roles and formats. **The runtime
files (`blocks.json`, `crashes.json`, `disabled.json`, `pin.json`) live under the state dir
(`~/.pi/agent/switchback/` by default, re-locatable via the `SWITCHBACK_DIR`
environment variable)** — not the project dir — because blocks and crashes
are account-scoped, not project-scoped. The legacy location
`<cwd>/.pi/switchback.json` is auto-migrated on first read (per-key max
timestamp wins) and then deleted.

| File | Format | Role | Owned by | Location |
|---|---|---|---|---|
| `switchback.yaml` | YAML | Human config: fallback list, optional decision model. The one config file, shared by every host. | user | see [The config file](#the-config-file) |
| `blocks.json` | JSON | Runtime blocked-until map (atomic write, lazy prune). Created on first block. Migrated from the legacy `<cwd>/.pi/switchback.json` path on first read. Shared with the [OpenCode plugin](opencode.md). | switchback | state dir (`SWITCHBACK_DIR`) |
| `crashes.json` | JSON | Runtime crash dedup store: sha256(raw) → entry. Created on first failure. User annotations become the Tier 2b cache. Shared with the [OpenCode plugin](opencode.md). | switchback | state dir (`SWITCHBACK_DIR`) |
| `disabled.json` | JSON | Manual disable list: model address → epoch ms it was disabled. Entries never expire; only `/switchback-enable` (or hand-editing) removes them. See [Manually disabling a model](#manually-disabling-a-model). | user (via commands) | state dir (`SWITCHBACK_DIR`) |
| `switchback.simulate.json` | JSON | Synthetic error scenarios. Now used by router tests + the opt-in live integration test; the user-facing simulate command was removed. | switchback | repo (cwd) |

The YAML-only rule applies to **user config** only. JSON stays for files that
are written by the runtime or used as read-only fixtures; switchback never
parses a user-supplied JSON config.

## The config file

There is one shared base config file:

```text
~/.config/switchback/switchback.yaml
```

Both pi and the [OpenCode plugin](opencode.md) read it. Either host may
additionally keep a **host-only overlay** next to it — `switchback.pi.yaml`
for pi, `switchback.oc.yaml` for OpenCode — for entries that only resolve in
that host (a classifier endpoint only one host can reach, chains built on
models only one host's catalog carries). At load time the host's overlay, when
present, merges over the base: a model entry whose `id` is already in the base
replaces it, a new `id` is appended, and `decisionProviders` / `decisionModels`
merge per key with the overlay winning. Every overlay section is optional, so
an overlay can hold a single extra chain or a single endpoint override, and a
missing overlay file is simply skipped. There is still no per-project config:
`~/.pi/agent/switchback.yaml` and `<cwd>/.pi/switchback.yaml` are **ignored**,
even if they exist. With no base file present (and no overlay), the built-in
`DEFAULT_CONFIG` (empty fallback list — surfaces a `ConfigError` pointing the
user at this section; see below) applies.

Overlays exist because the two hosts do not share a model catalog: an entry one
host can resolve becomes a dead fallback on the other. Keep the shared chains
in the base file and put host-only entries in that host's overlay, so neither
host carries chains it can never serve. One base means one shared truth, and
the overlay mechanism keeps the host-specific exceptions explicit instead of
forking the whole file.

`SWITCHBACK_CONFIG_DIR` moves the directory (used by tests and portable
installs); the file name stays `switchback.yaml`. A file that exists but fails
to parse or validate throws immediately — it is surfaced, never silently
ignored in favour of the built-in default.

A repeated `id:` inside `models:` is tolerated instead of fatal: the **first**
entry wins, every later duplicate is dropped, and both hosts print a warning
naming both positions (`models[3] repeats the id "switchback/auto" (first
defined at models[0]); the later entry was ignored`). A duplicated chain — a
stale editor write, a hand merge — used to take the whole extension down; now
the file still loads and the warning tells you what to remove. The
[configuration dialogue](configuration-dialogue.md) still refuses to *create* a
duplicate, so the dialogue never reintroduces the problem.

The repo ships only `switchback.yaml.example` as the template. Copy it to the
path above. `/switchback-config` (in both hosts) edits the base file and shows
its path before anything else, so an edit never lands somewhere unexpected (see
[Configuration dialogue](configuration-dialogue.md)). Overlays are hand-edited;
the dialogue does not touch them.

## Hot reload

No restart is needed for config changes. Both hosts re-read the base file and
their overlay on every request: pi's route reloads per route and falls back to
the last good config (with a warning) when an edit breaks parsing, so fallback
edits, classifier endpoint changes and the `debug` flag take effect on the next
request. OpenCode's bridge does the same per route call, and additionally
watches the config directory: a hand-edit to any of the three files republishes
the selector entries (debounced), while edits made through `/switchback-config`
republish immediately. A broken edit never kills a session in either host — the
previous good config keeps serving until the file parses again.

One exception: pi registers each chain as a virtual model once at startup, so
adding a brand-new chain `id` needs a session restart before that chain can be
selected. Editing the fallbacks or settings of an existing chain is live.

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
SWITCHBACK_DEBUG=1 opencode run --model switchback/auto "hello"
```

Both hosts read the override through the same core helper, so it means the same
thing everywhere. The flag covers the adapter's own stderr traces too (for
OpenCode: a failed dispatch, a failed request compile, a credential lookup that
threw), which are opt-in for the same reason — a failed hop is a cascade's
expected steady state and already reaches you as a switch line, and a stack
trace on every attempt trains you to ignore `[switchback]`.

With the flag off (the default) switches and traces are silent; the
no-classifier warning is always shown, regardless of this flag.

A missing credential reference is not diagnostics: an unresolvable
`secret:<name>` always warns with the entry it belongs to, because silently
dropping a key would leave a classifier that looks configured but cannot
authenticate.

## `DEFAULT_CONFIG` and the empty-fallbacks design

`DEFAULT_CONFIG` ships with `fallbacks: []`. This is intentional: if the user
config file does not exist, the router should fail loudly
with a clear `ConfigError` ("no fallbacks configured") rather than silently
fall through to a placeholder that may or may not exist in the catalog at
any given moment.

`switchback.yaml.example` carries the 4-provider fallback list as the
template; a copy of it at `~/.config/switchback/switchback.yaml` is what fills
`DEFAULT_CONFIG` in practice, for both hosts. There is no per-project override —
the base file plus that host's overlay (`switchback.pi.yaml` /
`switchback.oc.yaml`) is the whole config.
It contains only model ids and a classifier reference — no API keys, no
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

## Manually disabling a model

A greyed-out entry is one the catalog no longer resolves. The other case is an
entry that resolves fine but you do not want used: a free model whose quality
dropped, a provider that keeps returning junk, a model you keep in the list for
later. Disable it by hand instead of editing it out of `switchback.yaml` — the
config stays intact (so a fallback list regenerated by the `switchback-free`
skill keeps working) and
the model stays visible in status output.

Disables live in `disabled.json` in the state dir, keyed by model address, and
are **global**: one list shared by pi and the [OpenCode plugin](opencode.md), for
every chain that lists the model. Entries never expire; only an explicit enable
removes one.

```console
/switchback-disable ollama-cloud/glm-5.3-flash   # stop routing to it
/switchback-enable ollama-cloud/glm-5.3-flash    # route to it again
/switchback-enable all                           # clear the whole list
```

A disabled model is excluded from every pick — failover advancement, idle reset,
continuation stickiness, and pinned routing — so nothing resurrects it on the
next turn. `/switchback` marks it (`⊘` in pi, `[disabled by hand …]` in the
OpenCode listing) and prints the list with the file path. If every fallback in
a chain is disabled, the router surfaces exhaustion rather than silently
reaching for one.

The file is plain JSON, so a hand edit is allowed while nothing is running:

```json
{ "ollama-cloud/glm-5.3-flash": 1767000000000 }
```

The value is the epoch-ms stamp kept for display; the presence of the key is
what disables the model.

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

## Decision model (`decisionModel:`)

A virtual model names its classifier by **address**, exactly like a fallback:
`provider/model-id`. There is no separate `jev:` block and no name indirection.

```yaml
models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - zai/glm-5.3
    decisionModel: typesafe/jev-latest
```

The address resolves one way or the other, and the difference is the presence of
a `decisionModels:` entry for it:

- **No entry — catalog resolution.** pi looks the classifier up in its model
  catalog and supplies the endpoint, wire API and credential (whatever `/login`
  or the provider's environment variable configured). Switchback stores nothing
  and asks for nothing on this path. OpenCode has no classifier catalog, so the
  same address reports a startup warning naming the missing piece (`decisionProviders.<provider>`)
  instead of failing silently.
- **Entry with `baseUrl` — a direct endpoint.** Switchback drives the endpoint
  itself over the SystemOne wire API, in both hosts. This is the case that needs
  a switchback-side credential.

An address can also inherit its connection from a provider entry — see the
decisionProviders section below. When both exist, the address-level entry wins.

### `decisionModels:` — connection details

The top-level `decisionModels:` map is keyed by the same address and only
carries connection details:

```yaml
decisionModels:
  "ollama/tev1:0.8b":
    baseUrl: http://localhost:11434/v1
    apiKey: ollama
```

The key is the address, so it may contain `/` and `:` (both legal in a YAML
plain key) — but quote it whenever the model id contains a colon: an unquoted
`:` is a mapping break to a YAML parser, while a colon followed by a
non-space character is just text. Quoting is always safe and is what the
`/switchback-config` dialogue writes when an address needs it.

Fields:

- `baseUrl` — `http(s)` URL of the SystemOne endpoint. Optional: an entry
  without one is an **empty override** — it shadows the provider entry
  entirely and leaves the address catalog-resolved (see below).
- `apiKey` — bearer token. **Required with `baseUrl`**; use `local` for
  endpoints that ignore the bearer token (Ollama), or `secret:<name>` to point
  at the encrypted store on pi.

### `decisionProviders` — per-provider connections

A provider's classifiers share one endpoint and one credential, so connection
details can be declared once per provider instead of once per address. The
`decisionProviders:` map is keyed by the **provider id** (no `/`, no model id):

```yaml
models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - ollama/minimax-m3
    decisionModel: ollama/tev1:0.8b

decisionProviders:
  ollama:
    baseUrl: http://localhost:11434/v1
    apiKey: local
```

Every `ollama/*` address now resolves through that entry — a second model
switching to `ollama/tev2` needs no further config. The fields and the strict
rules are exactly the `decisionModels:` ones above, with one addition: a
provider key containing `/` is an error (`must be a provider id (e.g.
"ollama"), not a "provider/model" address`).

Precedence (whole entry, not field-by-field): a `decisionModels:<address>`
entry overrides the provider entry **in its entirety** — an empty override
(`ollama/tev1: {}`) does not fall back to the provider for the missing
fields; it puts that one address back on catalog resolution. The provider
entry covers every address of the provider that has no own entry; addresses
with neither resolve from the host catalog (pi) or report the OpenCode
startup warning.

When to use which: on **pi**, `decisionProviders` is only needed when the
provider is not in pi's catalog (a local llama.cpp/Ollama box) — catalog
addresses need nothing at all. On **OpenCode** it is the primary way to give a
decision model a connection, because that host has no catalog to resolve
from.

The loader is deliberately strict about a half-configured entry and deliberately
loud about a retired one. None of these are silent:

| Config | Result |
| ------ | ------ |
| `baseUrl` without `apiKey` | error: `apiKey is required with baseUrl - use "local" for endpoints that ignore the bearer token` |
| `apiKey` without `baseUrl` | error: `apiKey requires baseUrl` |
| unknown key anywhere | warning naming the key and the file |
| retired `jev:` block | warning: `use decisionModel: <provider>/<model-id> instead` |
| retired `api:` field | warning: drop it — a `decisionModels` entry always speaks SystemOne |
| list-form `decisionModels:` | warning; the list is ignored |
| `secret:<name>` that does not resolve | warning naming the entry; the key is dropped, the load continues |
| `decisionProviders` key containing `/` | error: `must be a provider id ... not a "provider/model" address` |

An entry that carries no connection details is **not** a warning on pi: the
address still resolves from the catalog, and an override may legitimately be
waiting for a model to adopt it. On OpenCode the same situation leaves the
address unusable, and the host check says so at startup (see below).

### When a decision model does not resolve

An address can be well-formed and still name nothing: a typo (`tev2` for
`tev1`), a model deleted from the local Ollama, a catalog rename. On the first
route of a session switchback checks every referenced decision model against
the host registry and warns once per unresolvable address:

```text
switchback decision model "ollama/tev2" was not found - switchback falls back to
blind cycling and level clamping until it resolves
```

Routing continues deterministically while the warning stands: errors blind-cycle
through the fallback list and the reasoning category is clamped to the routed
model. When the model appears again (pulled into Ollama, catalog refreshed), the
warning simply stops.

Two cases never reach that check. An address with its own `baseUrl` (or a
`decisionProviders` entry) points at a SystemOne endpoint that publishes no
model list, so there is nothing to look up — the registry is not asked. And on
OpenCode, where there is no registry at all, a referenced address without any
connection details reports its own startup warning instead:

```text
switchback config: decision model "typesafe/jev-latest" has no connection
details and OpenCode has no classifier catalog - add decisionProviders.typesafe
(baseUrl + apiKey) or switchback cannot classify through it
```

### Direct endpoints and pi's registry

With `baseUrl` present, switchback registers the provider through pi-ai's
`typesafe-system-one` transport, so a local SystemOne server needs no pi
provider and no `models.json` entry. This is the only supported way to run pi
against a local decision model. The OpenCode adapter has no host registry: it
drives the same endpoint directly through `switchback-core`'s own SystemOne
transport (`systemone.ts`, same wire protocol, same URL conventions).

Several decision models may share one endpoint. They are registered together in
a single provider declaration, because pi replaces a provider's whole model list
when an extension supplies one — a model left out of that call would be invisible
to the registry and classify as `unresolvable`.

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

A `decisionModels:` entry that no virtual model references simply sits unused —
it is not registered and the router sees no classifier for that address, but it
stays available for a model to adopt later (the `/switchback-config` dialogue
offers it in the picker). Entries can stay in the map while a model list is
being edited.

Example — pi's own catalog (no entry, no key in the config):

```yaml
models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - zai/glm-5.3
    decisionModel: typesafe/jev-latest
```

Example — a direct endpoint pi does not know (Ollama v0.35+):

```yaml
models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - ollama/minimax-m3
    decisionModel: ollama/tev1:0.8b

decisionModels:
  "ollama/tev1:0.8b":
    baseUrl: http://localhost:11434/v1
    apiKey: local
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
  my-provider/my-model:
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

Under OpenCode there is no encrypted store (the host exposes no readable
vault); the OpenCode plugin resolves the same `secret:<name>` references
against environment variables instead — see
[OpenCode → Secrets](opencode.md#configuration).

A reference that does not resolve is a warning, not a failed load: the entry
keeps its `baseUrl`, its `apiKey` is omitted, and the host reports

```text
decisionModels.my-provider/my-model.apiKey "secret:my-provider-key" does not
resolve (secret "my-provider-key" is not in the store) - the key is ignored
```

One unavailable credential therefore costs that one classifier rather than the
whole config, which is what makes an unset environment variable on OpenCode a
routine state instead of a plugin that refuses to start.
