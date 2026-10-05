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
| `switchback.yaml` | YAML | Human config: fallback list, optional Jev classifier. Ship in your repo or `~/.pi/agent/`. | user | cwd or agent dir |
| `blocks.json` | JSON | Runtime blocked-until map (atomic write, lazy prune). Created on first block. Migrated from the legacy `<cwd>/.pi/switchback.json` path on first read. | switchback | `<piConfigDir>/switchback/` |
| `crashes.json` | JSON | Runtime crash dedup store: sha256(raw) → entry. Created on first failure. User annotations become the Tier 2b cache. | switchback | `<piConfigDir>/switchback/` |
| `switchback.simulate.json` | JSON | Synthetic error scenarios for `/switchback-simulate`. | user (shipped) | repo (cwd) |

The YAML-only rule applies to **user config** only. JSON stays for files that
are written by the runtime or used as read-only fixtures; switchback never
parses a user-supplied JSON config.

## Lookup order (first valid match wins)

1. `<cwd>/switchback.yaml`
2. `~/.pi/agent/switchback.yaml`
3. Built-in `DEFAULT_CONFIG` (empty fallback list — surfaces a `ConfigError`
   pointing the user at this section; see below).

The cwd slot takes priority over the agent-dir slot. Practically:

- **Inside the project directory** (e.g. `cd <repo>`): the project's own
  `switchback.yaml` is loaded.
- **Anywhere else** (e.g. from `~`, or from any unrelated project): the
  agent-dir copy at `~/.pi/agent/switchback.yaml` is loaded.

The agent-dir copy is what the daily-driver Path B install creates; the
project copy is what contributors and CI use. The lookup is cwd-first so
per-project overrides always win.

## `DEFAULT_CONFIG` and the empty-fallbacks design

`DEFAULT_CONFIG` ships with `fallbacks: []`. This is intentional: if a user
has neither a cwd copy nor an agent-dir copy, the router should fail loudly
with a clear `ConfigError` ("no fallbacks configured") rather than silently
fall through to a placeholder that may or may not exist in the catalog at
any given moment.

The shipped `switchback.yaml` (and its `.example` twin) carries the
4-provider fallback list and is what fills `DEFAULT_CONFIG` in practice. Both
files contain only model ids and a classifier reference — no API keys, no
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
