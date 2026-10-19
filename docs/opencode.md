# OpenCode plugin

`opencode-switchback` brings the same quota-aware fallback routing to
[OpenCode](https://opencode.ai) V2. It reads the same `switchback.yaml`, talks
to the same classifier, and shares the same account-scoped block store — a
quota wall hit under pi is already under `models` for OpenCode, and vice
versa.

## Install

Add the plugin to `opencode.json(c)`:

```jsonc
{
  "plugins": ["opencode-switchback"]
}
```

Versioned, scoped and Git installs follow the
[OpenCode plugin loaders](https://opencode.ai/v2/docs/plugins), e.g.
`opencode plugin add opencode-switchback` or, straight from this repository,
`opencode plugin add github:jr2804/switchback::path:packages/opencode`
(the `switchback-core` dependency resolves from npm).

From a source checkout, point the config at the plugin file directly
(node resolution walks up into the checkout's `node_modules`, so run
`npm install` in the checkout first):

```jsonc
{
  "plugins": ["../switchback/packages/opencode/src/index.ts"]
}
```

## How routing works

OpenCode has no per-request virtual model, so the plugin works at a turn
boundary instead of in flight:

1. OpenCode classifies a provider failure on its own and proposes its retry
   policy.
2. The plugin's `retry` hook then classifies the same raw error text through
   the configured classifier (same verdict taxonomy as pi) and updates the
   shared block state: quota / auth / unknown entries get a blocked-until
   window (the classifier's reset time, or the default window when the
   classifier gives none).
3. If the failing model is a `models` entry and anything is still effective,
   the plugin calls `session.switchModel` so subsequent requests use the next
   effective fallback and notifies you in the session.
4. When nothing is effective, the plugin flips the retry decision to
   no-retry — better to stop than to slam a wall that is already proven down.

Shared semantics with pi: classifier-only decisions (no keyword sets, no
regex), visible notification on every no-verdict path, and a `crashes.json`
entry whenever the plugin cannot decide and OpenCode's own stands. A failure
in a model that is not in any `models` list is left untouched — the plugin
does not manage chains it was not configured for.

## Configuration

The plugin reads the same [`switchback.yaml`](configuration.md) layers as pi:

| Layer | Lowest → highest |
|---|---|
| neutral basis (agent-agnostic) | `~/.config/switchback/switchback.yaml` |
| agent overlay | `~/.pi/agent/switchback.yaml` |
| project override | `<cwd>/.pi/switchback.yaml` |

Runtime state (`blocks.json`, `crashes.json`) lives under
`~/.pi/agent/switchback/` and is shared with pi; set `SWITCHBACK_DIR` to
relocate it. A `decisionModel:` address with no `decisionModels:` entry is a
catalog lookup, and OpenCode has no classifier catalog — the plugin notifies
that no verdict is available and lets OpenCode's own policy stand; it never
blocks on a guess. Point the address at an entry with `baseUrl` to give the
plugin a direct SystemOne endpoint (see [Configuration](configuration.md)).

Secrets: OpenCode has no readable secret vault (its credential store
activates stored profiles and never returns key material), so the OpenCode
plugin resolves `secret:`-prefixed `decisionModels[].apiKey` references against
environment variables: `secret:MY_KEY` reads `MY_KEY` from the environment.
A reference that does not resolve disables the plugin for that attempt with
a visible notice — the same failure mode as pi, against a different store.

## Commands

| Command | Effect |
|---|---|
| `/switchback` | List every configured chain with its current state (effective availability, blocked-until). |
| `/switchback-unblock` | Same listing. |
| `/switchback-unblock <ID>` | Clear the block on one model id (`provider/model`, case-insensitive). |
| `/switchback-unblock ALL` | Clear the entire block map. |

Slash commands are dispatched by the OpenCode clients (TUI, web). Non-interactive
`opencode run "…"` sends its argument as a literal prompt, so use the clients to
invoke them.

## Differences from pi

| pi | OpenCode plugin |
|---|---|
| Advances in flight inside the failing request | Advances at a turn boundary (`switchModel` before the next attempt) |
| Virtual model `switchback/auto` in the picker | Not applicable — the configured physical models are picked normally |
| Resolves `secret:` refs via the encrypted DPAPI store | Resolves `secret:` refs against environment variables (OpenCode exposes no readable vault) |
| Pinning the target for one turn | Not available per request; re-run with the wanted pin model selected |
| Reasoning-level routing with per-model clamps | Classification/routing identical; reasoning levels follow OpenCode's own model capabilities |

OpenCode-side behaviors switchback cannot influence (observed in OpenCode 2.0.32):

- Once every fallback in a chain is blocked, switchback flips the retry decision
  and the main request surfaces the original error — but OpenCode's background
  title generation retries failures on its own schedule, ignoring the retry
  decision, and can keep calling a blocked model for a while. The blocks still
  apply to every future turn.
- `opencode run` prints the surfaced failure, not session messages, so the
  switchback notices (advance/block explanations) are visible in the clients,
  not in `run` output.
