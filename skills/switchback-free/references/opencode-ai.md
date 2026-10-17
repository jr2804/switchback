# opencode.ai (opencode-go, opencode-zen)

## Check active

```bash
# Check if opencode-go is configured
opencode models --provider opencode-go

# Check if opencode-zen is configured
opencode models --provider opencode-zen
```

If either returns a list of models, that provider is active. Skip providers
that error or return empty.

## Query model list

```bash
# List models from opencode-go
opencode models --provider opencode-go --limit 500

# List models from opencode-zen
opencode models --provider opencode-zen --limit 500
```

## Free-model detection

opencode.ai free models follow the `-free` suffix convention:
- `opencode-go/gpt-4o-mini-free`
- `opencode-zen/claude-3-5-sonnet-free`
- `opencode-zen/gemini-2.0-flash-free`

### Special cases

No known special cases — all opencode.ai free models use the `-free` suffix.

## Verification

Confirm each candidate model appears in the model-list response for the
respective provider. If a hardcoded name is missing, mark it stale and
recommend filing an issue at the opencode.ai repository.
