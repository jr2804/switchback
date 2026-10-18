# openrouter.ai

## Check active

```bash
# Check if openrouter is a configured provider in opencode
opencode models --provider openrouter
```

If this returns a list of models, the provider is active. If it errors or
returns empty, skip this provider.

## Query model list

```bash
# List all models from OpenRouter
opencode models --provider openrouter --limit 500
```

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

| Model ID              | Notes                          |
| --------------------- | ------------------------------ |
| `big-pickle`          | Experimental, no `:free` suffix |

## Verification

Confirm each candidate model appears in the model-list response. If a
hardcoded name (like `big-pickle`) is missing from the list, mark it stale and
recommend filing an issue at <https://github.com/openrouter/openrouter/issues>.
