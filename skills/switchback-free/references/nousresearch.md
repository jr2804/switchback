# nousresearch.com

## Check active

```bash
# Check if nousresearch is a configured provider in opencode
opencode models --provider nousresearch
```

If this returns a list of models, the provider is active. If it errors or
returns empty, skip this provider.

## Query model list

```bash
# List all models from Nous Research
opencode models --provider nousresearch --limit 500
```

Or via the REST endpoint (requires `NOUS_API_KEY`):

```powershell
Invoke-RestMethod -Uri "https://api.nousresearch.com/v1/models" `
  -Headers @{ Authorization = "Bearer $env:NOUS_API_KEY" } |
  Select-Object -ExpandProperty data |
  Select-Object id, name, @{N='free'; E={ $_.id -match '(:free|-free)$' }}
```

## Free-model detection

Nous Research free models follow the `:free` suffix convention:

- `nousresearch/hermes-3-llama-3.1-8b:free`
- `nousresearch/hermes-2-pro-mistral-7b:free`

### Special cases

No known special cases — all Nous Research free models use the `:free` suffix.

## Verification

Confirm each candidate model appears in the model-list response. If a
hardcoded name is missing, mark it stale and recommend filing an issue at
<https://github.com/nousresearch/hermes-function-calling/issues> or the
Nous Research API repository.
