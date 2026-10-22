# openrouter.ai

## Check active

```bash
# List every configured provider's models (the CLI takes no provider flag)
opencode models | grep '^openrouter/'
```

If this returns lines, openrouter is active. If it errors or returns nothing,
skip this provider.

## Query model list

```bash
opencode models | grep '^openrouter/'
```

(As of opencode CLI v2.1.3 there is no `--provider` or `--limit` flag.)

Or via the REST endpoint (requires `OPENROUTER_API_KEY`):

```powershell
Invoke-RestMethod -Uri "https://openrouter.ai/api/v1/models" `
  -Headers @{ Authorization = "Bearer $env:OPENROUTER_API_KEY" } |
  Select-Object -ExpandProperty data |
  Select-Object id, name, @{N='free'; E={ $_.id -match '(:free|-free)$' }}
```

## Free-model detection

OpenRouter free models follow the `:free` suffix convention:

- `meta-llama/llama-3.1-8b-instruct:free`
- `google/gemini-2.0-flash-exp:free`
- `qwen/qwen-2.5-7b-instruct:free`
- `mistralai/mistral-7b-instruct:free`

### Special cases (no suffix, always free)

None today. (`big-pickle` used to be listed here; as of 2026-10-23 it appears
under the `opencode` provider — see `references/opencode-ai.md`.)

## Verification

Confirm each candidate model appears in the model-list response. If a
hardcoded name (like `big-pickle`) is missing from the list, mark it stale and
recommend filing an issue at <https://github.com/openrouter/openrouter/issues>.
