# switchback

Quota-aware graceful model fallback for [pi](https://github.com/earendil-works/pi).

`switchback` registers a virtual model `switchback/auto`. Every request is
routed through a user-configured fallback list; provider failures are
classified by a single SystemOne classifier and the router advances on
quota / auth / unknown, retries on transient, sticks on context overflow.
When no classifier is available the router visibly notifies and cycles to
the next non-blocked entry — the cycle is the universal baseline.

Classifier-only by design: no keyword sets, no regex, no heuristics, and no
prompt criteria taken from collected provider traffic (root `AGENTS.md`
project rule 7). A captured error message is a test input, never a reason to
change the prompt.

## Start here

- **[Quickstart in the README](https://github.com/jr2804/switchback/blob/main/README.md)** — `pi install …` and
  first-run verification.
- **[Configuration](configuration.md)** — `switchback.yaml`, lookup order,
  greyed entries, `DEFAULT_CONFIG`, the `jev:` classifier config.
- **[Interactive configuration](configuration-dialogue.md)** — the
  `/switchback-config` wizard: layers, fallbacks, decision models, the
  live model browse and the capability test.
- **[Classifier](classifier.md)** — live classifier validation (env vars,
  TypeSafe hosted / OpenRouter / llama.cpp / Ollama) and the coverage
  matrix.

## Project

- **[License](license.md)** — MIT.

## For developers

Maintainer and contributor documentation lives in the **Development**
section of the docs site:

- [Development overview](development.md) — implementation status, test
  layout, install from source.
- [Architecture](architecture.md) — file roles, routing flow, known
  limitations.
- [Contributing](contributing.md) — dev setup, style, verification, commits.
- [Issue tracking](issue-tracking.md) — beads workflow, personal-data scrub.
- [Versioning](versioning.md) — CalVer `YYYY.0M.N`, tags, release workflow.
- [Crash collection](crash-collection.md) — `crashes.json` and the
  Tier 2b annotation cache.

## Building the site

```bash
uv tool install mkdocs mkdocs-material
mkdocs serve       # local preview
mkdocs gh-deploy   # publish to GitHub Pages
```
