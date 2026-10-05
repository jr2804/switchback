# Configuration

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
| `switchback.simulate.json` | JSON | Synthetic error scenarios for `/switchback-simulate`. | user (shipped) | repo (cwd) |

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
The repo ships only `switchback.yaml.example` as the template. Practically:

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

Omitting `baseUrl` keeps the old behaviour: the classifier is looked up
in pi's catalog from `provider` + `id` only.

Example — Ollama v0.35+ decision model:

```yaml
models:
  - id: switchback/auto
    name: Auto (Switchback)
    fallbacks:
      - ollama/minimax-m3
    jev:
      provider: ollama-systemone
      id: tev1:0.8b
      baseUrl: http://localhost:11434/v1
      apiKey: ollama
```

Notes:

- Ollama decision-capability gotcha: see [Classifier → Example: local Ollama](classifier.md#example-local-ollama-decision-models).
- For the env-var-driven test path against a live classifier (TypeSafe
  hosted / OpenRouter / llama.cpp / Ollama), see
  [Classifier → Live classifier validation](classifier.md#live-classifier-validation-opt-in).
