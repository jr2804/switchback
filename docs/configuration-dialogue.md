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
  entry is the preferred model). At least one fallback is required.
- **Decision models** — the reusable `decisionModels:` entries: add, edit
  fields (provider, id, `baseUrl`, `api`, API key), rename (references in
  `models[].jev` are rewritten in the same step), delete. Deleting an entry
  that is still referenced by a model is refused; re-point those models
  first. Clearing a model's decision model makes it report and cycle without
  a classifier.
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
