# Configuration dialogue (`/switchback-config`)

`/switchback-config` is an interactive editor for your switchback
configuration. Instead of hand-editing `switchback.yaml`, you pick actions
from menus and enter values at prompts; each completed action is validated
against the same rules the loader applies and saved to the file immediately.

Requires a UI-capable context (the terminal UI or RPC). In headless modes
the command reports and exits without prompting.

## What you can edit

- **Virtual models** — add a model (bare ids like `auto` are written as
  `switchback/auto`), rename its id or display name, remove it. Renaming an
  id changes the registered virtual model, so pi must be restarted for the
  old id to disappear. The last remaining virtual model cannot be removed.
- **Fallbacks** — add, remove, and reorder (`provider/id` entries; the first
  entry is the preferred model). **Adding opens a searchable picker** over pi's
  model catalog — the `/model` experience: type any part of a provider, model id
  or display name to filter, `↑`/`↓` to move, `Tab` or `Enter` to accept, `Esc` to
  cancel. Each entry shows its display name, context window and whether the
  provider has credentials yet (`no credentials` is marked, not enforced), and
  the ones already in the list are flagged `in the list`. Typing a complete
  `provider/id` and pressing `Enter` accepts it verbatim, which is how a model
  outside the catalog is added. At least one fallback is required.
- **Decision models** — the reusable `decisionModels:` entries: add, edit
  fields, rename (references in `models[].jev` are rewritten in the same step),
  delete. **The provider list is pi's own**: every provider the model registry
  reports that ships at least one classifier model, with the registry's display
  name, base URL and model ids. Switchback names no provider, no URL and no model
  id itself, so whatever `/login` (or a provider's environment variable) made
  available shows up here — that is the whole auth story for a catalog
  classifier. `Other (type a provider id)...` is the escape hatch for an endpoint
  pi does not know; the wizard then asks for its base URL, because there is no
  catalog entry to prefill from.
  - **Base URL** — for a provider from pi's catalog the config normally carries
    **no** `baseUrl` at all (`Enter` keeps that): pi resolves the endpoint, the
    wire API and the credential. Typing one is an explicit override, and the
    wizard refuses it when pi already serves chat models under that provider id,
    because registering a classifier there would replace them.
    For an endpoint pi does not know the base URL is required.
    `-` always means "no direct endpoint".
  - **Wire API** is not a question: a direct endpoint speaks exactly one
    (switchback's SystemOne transport), so it is written with the endpoint
    instead of offering a meaningless `(none)`.
  - **Model id** — the provider's own classifier models. When the catalog knows
    none and the endpoint is reachable, the wizard asks the server itself
    (Ollama's `/api/tags`, filtered by the `"decision"` capability), so a freshly
    pointed endpoint does not have to wait for a routing failure to reveal a
    wrong model id.
  - **API keys** are asked for only for a direct endpoint, and only as a value —
    the store name is derived from the entry, because it is an internal detail
    of `secret:<name>`. A catalog classifier gets its credential from pi.
  derived from the decision-model name (`dm2-key`), so a single secret can
  be re-keyed under the new name. Deleting an entry that is still referenced
  by a model is refused; re-point those models first. Clearing a model's
  decision model makes it report and cycle without a classifier.
- **Classifier test** — after a decision model is saved (and from its menu
  later) switchback offers a **one-shot capability check**: a single SystemOne
  prompt carrying all three answer shapes a decision model must produce — a
  `choice`, a `score` and a `bool` (System One's `noul`) — with a verdict per
  shape. Most SystemOne endpoints publish no model list, so the model id is
  guessed; this is where a wrong guess, a model without the `decision`
  capability, or an endpoint that is not a SystemOne server at all shows up —
  instead of at the first routing failure. It answers, for example:

  ```text
  switchback decision-model test: ollama/tev1:0.8b at http://localhost:11434/v1 (412 ms)
    choice  ✓ sunny
    score   ✓ 1.02 (An even chance)
    noul    ✓ yes
  ```

  The `score` line is a **rubric index** (the probe's rubric has three levels,
  so a fair coin should land on index 1), which is why it is shown with the
  level it lands on rather than as a bare number.

- **Debug** — toggles the top-level `debug:` flag (per-switch diagnostics).
- **Layer switch** — the dialogue asks **which layer to edit before anything
  else**, and "Switch layer..." in the main menu asks again. The chooser shows
  both files and what each currently holds, for example:

  ```text
  which config layer do you want to edit?
    global:  ~/.pi/agent/switchback.yaml
    project: <cwd>/.pi/switchback.yaml
  Project entries override global entries with the same model id.

    Global - 2 models        <- offered first
    Project - not present
  ```

  `not present` means the file does not exist yet (a first save creates it),
  `N models` is what the layer holds now, and `unreadable (invalid config)`
  means the file exists but breaks a config rule. The preferred layer is
  offered first (press Enter to take it): **global** — the base every project
  inherits — unless only a project file exists, in which case that one is
  plainly what you are working with. Esc cancels. Every screen title also shows
  the file path being edited, so it is always clear where a change lands.

## API keys and the secret store

The dialogue never writes a literal API key into the YAML. When you enter a
key, it is stored in the encrypted store (`<piConfigDir>/switchback/secrets.json`,
encrypted with Windows DPAPI) and the config carries a reference of the form:

```yaml
apiKey: secret:my-ollama-key
```

You can also reference a secret that already exists in the store. The store
is managed from the dialogue (new key, pick existing name, remove); see
[Configuration → Encrypted API-key store](configuration.md#encrypted-api-key-store-secretname)
for the on-disk format and platform notes.

## Validation and safety

- Every save runs the loader's own validation before anything is written, so
  the file always stays loadable — a rejected edit (an unknown
  `decisionModel` name, a malformed fallback id, a duplicate model id) is
  reported with the loader's exact message and reverted; the file on disk is
  unchanged.
- Writes are atomic (temporary file + rename), and a first save into a fresh
  project layer creates the directory and a commented starter file.
- Comments and key order in your existing `switchback.yaml` are preserved
  through edits.
- If the file on disk is already invalid (for example after a hand edit),
  the dialogue reports the loader's message and declines to open it; fix the
  file by hand and retry.

## Reference

The full YAML reference — layers and aggregation, the `jev:` classifier
block, `decisionModels:`, and the `debug:` flag — lives in
[Configuration](configuration.md).
