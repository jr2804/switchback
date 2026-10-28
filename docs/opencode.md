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

One entry loads all three halves of the plugin: the server part routes, the TUI
part renders in the terminal, and the GUI part renders in OpenCode Desktop.
Versioned, scoped and Git installs follow the
[OpenCode plugin loaders](https://opencode.ai/v2/docs/plugins), e.g.
`opencode plugin add opencode-switchback` or, straight from this repository,
`opencode plugin add github:jr2804/switchback::path:packages/opencode`
(the `switchback-core` dependency resolves from npm).

The GUI half is a prebuilt bundle (`./gui-experimental`), and OpenCode Desktop
reads plugins from `opencode.json(c)` only — not from `cli.json`. A package
that was listed only in `cli.json` for the TUI must also appear in
`opencode.json(c)` once you want it in the desktop app.

From a source checkout, point the config at the plugin file directly
(node resolution walks up into the checkout's `node_modules`, so run
`npm install` in the checkout first):

```jsonc
{
  "plugins": ["../switchback/packages/opencode/src/index.ts"]
}
```

## How routing works

Your chains appear in the model selector as ordinary models of a
**Switchback** provider — `switchback/auto`, `switchback/fast`, whatever your
config names. Pick one and switchback decides, per request, which physical
model actually answers:

1. The core router runs the same `decide()` call pi makes at its virtual-model
   seam: session stickiness, the pin, idle reset, context fit.
2. The chosen model's request is dispatched. If it fails, the error text goes
   to the configured classifier, and the verdict (quota / auth / transient /
   unknown) blocks that model for the reset window it reports.
3. The next effective fallback is tried **inside the same request**, so the
   turn completes on a model that works. You never see the failed attempt; you
   get a notice telling you which model answered instead.
4. When nothing effective is left, the router reports `exhausted` and OpenCode
   surfaces the last failure.

That is the pi behaviour, reached through a different host seam: OpenCode has
no per-request virtual model, so the adapter publishes a provider whose route
delegates to the physical model instead.

Shared semantics with pi: classifier-only decisions (no keyword sets, no
regex), visible notification on every no-verdict path, and a `crashes.json`
entry whenever the router cannot decide and the host's own error stands.

### Notices

Advance, block and exhaustion notices reach you three ways. In the TUI they are
**toasts** — a transient block that does not enter the conversation. In OpenCode
Desktop they are the app's own toasts. In headless `opencode run`, or any client
without a TUI or GUI half loaded, the same text arrives as a session notice
instead, so nothing is silently lost.

All three surfaces are clients of the same server RPC, so a notice decided
server-side appears on whichever one is attached.

### Model names

Published models carry their chain id without the provider prefix: a chain
`switchback/auto` is `auto` inside the Switchback provider, shown in the
selector as `switchback/auto`.

## Configuration

The plugin reads the one shared config file, exactly as pi does
([`~/.config/switchback/switchback.yaml`](configuration.md#the-config-file)).
There is no OpenCode-specific and no per-project config: a copy under
`~/.pi/agent/` or `<cwd>/.pi/` is ignored. One file means both hosts run the
same chain list, which matters because they do not share a model catalog.

Runtime state (`blocks.json`, `crashes.json`, `disabled.json`, `pin.json`) lives under
`~/.pi/agent/switchback/` and is shared with pi; set `SWITCHBACK_DIR` to
relocate it. A `decisionModel:` address with no `decisionModels:` entry is a
catalog lookup, and OpenCode has no classifier catalog — the plugin notifies
that no verdict is available and cycles to the next effective model without
blocking. Point the address at an entry with `baseUrl` to give the plugin a
direct SystemOne endpoint (see [Configuration](configuration.md)).

Secrets: OpenCode has no readable secret vault (its credential store
activates stored profiles and never returns key material), so the OpenCode
plugin resolves `secret:`-prefixed `decisionModels[].apiKey` references against
environment variables: `secret:MY_KEY` reads `MY_KEY` from the environment.
A reference that does not resolve disables the plugin for that attempt with
a visible notice — the same failure mode as pi, against a different store.
The physical models switchback dispatches to are a different matter: their
credentials come from OpenCode's own connection store, so whatever you
configured there is what the fallback call uses.

## Commands

All of them are slash commands in the TUI. The non-interactive
`opencode run "…"` sends its argument as a literal prompt, so use a client to
invoke them.

| Command | Effect |
|---|---|
| `/switchback` | List every configured chain with its current state (effective availability, blocked-until, disabled-by-hand). |
| `/switchback-config` | Edit the configuration. Bare, it reports the effective config; `help` lists the verbs. In the TUI it opens a guided menu. |
| `/switchback-next` | Move the pin to the next fallback of the chain you are using (and pin when it is unpinned). |
| `/switchback-model <ID\|auto>` | Pin the chain to one fallback, or `auto` to clear the pin. |
| `/switchback-blocked` | List the models currently blocked, with the time they unblock. |
| `/switchback-crashes [n]` | List the most recent N crash entries (default 10). |
| `/switchback-annotate <hash> <class> [note…]` | Annotate a crash with a confirmed class. |
| `/switchback-unblock <ID\|ALL>` | Clear the block on one model, or the whole block map. |
| `/switchback-disable <ID>` | Keep a model out of every chain until re-enabled (writes `disabled.json`; see [Manually disabling a model](configuration.md#manually-disabling-a-model)). |
| `/switchback-enable <ID\|ALL>` | Re-enable one manually disabled model, or all of them. |

### `/switchback-config`

The argument grammar is the same one the guided menu uses, so every menu
action is a command you could have typed:

```text
/switchback-config                            current config
/switchback-config <filter>                   just the chains matching it

/switchback-config add <id> <name> <fallbacks>
/switchback-config remove <id>
/switchback-config rename <id> <new-id>
/switchback-config name <id> <display name>

/switchback-config chain <id> <fallbacks>     replace the whole list
/switchback-config chain-add <id> <fallback>
/switchback-config chain-remove <id> <n>
/switchback-config chain-move <id> <from> <to>

/switchback-config idle-reset <id> <value>
/switchback-config decision-model <id> <provider/model|off>

/switchback-config debug <on|off>
/switchback-config reset                      delete the config file
```

`<fallbacks>` is a comma-separated `provider/model` list, first entry
preferred. Positions are 1-based, exactly as the report numbers them. Every
mutation is validated by the loader before it is written, so a rejected edit
leaves the file untouched and reports the loader's own message.

In the TUI, `/switchback-config` opens a menu instead: pick a chain, then add,
remove and reorder its fallbacks from a searchable catalog picker (type any
part of a provider or model id, `↑`/`↓` to move, `Enter` to accept, `Esc` to
cancel). The menu talks to the server through the same grammar above — it never
writes files itself — so the two paths cannot disagree.

The same menu is available in OpenCode Desktop (`/switchback-config` in the
composer, or **Switchback configuration** in the command palette), rendered
with the app's own dialogs and toasts. It is the same guide code as the TUI's,
over the same RPC, so the three surfaces stay in step.

## Differences from pi

| pi | OpenCode plugin |
|---|---|
| Resolves `secret:` refs via the encrypted DPAPI store | Resolves `secret:` refs against environment variables (OpenCode exposes no readable vault) |
| Interactive dialogue with multi-field wizard screens | Guided menu over the same command grammar, in both the TUI and the desktop app, plus the typed command itself |
| Reasoning levels chosen from the model's own scale | Classification and routing identical; the settled level is applied on the wire for models that accept an `effort` part |

OpenCode-side behaviors switchback cannot influence:

- **Background jobs are outside the route.** Title generation retries on
  OpenCode's own schedule and does not go through the chain router, so it can
  keep calling a model switchback has blocked. Blocks still apply to every
  future turn.
- **`opencode run` prints the surfaced failure**, so a switch that only appears
  as a notice is visible in a client, not in `run` output.
