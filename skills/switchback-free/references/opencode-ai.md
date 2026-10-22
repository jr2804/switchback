# opencode.ai (opencode, opencode-go)

## Check active

```bash
# List every configured provider's models (the CLI takes no provider flag)
opencode models
```

Providers are the `provider/` prefix of each line. opencode.ai is active when
lines start with `opencode/` or `opencode-go/`. Skip providers with no lines.

## Query model list

```bash
opencode models | grep '^opencode/'
opencode models | grep '^opencode-go/'
```

(As of opencode CLI v2.1.3 there is no `--provider` or `--limit` flag; the
command prints all providers and you filter client-side.)

## Free-model detection

opencode.ai free models follow the `-free` suffix convention:

- `opencode/beam-free`
- `opencode/deepseek-v4.1-flash-free`
- `opencode-go/beam-free`

### Special cases

| Model ID           | Notes                                                  |
| ------------------ | ------------------------------------------------------ |
| `opencode/big-pickle` | No `-free` suffix but always free (observed 2026-10-23) |

### Cross-client caveat

Most `opencode/*` free models answer only from within the OpenCode app;
other clients (pi, curl) get `403 FreeTierError`. Keep them in `sb-free` —
the chain's primary host is OpenCode — but expect pi runs to classify, block,
and cycle past them (the classifier-given resets observed in testing were
minutes, not days). Some entries (e.g. `opencode/nemotron-3.5-lightning-free`)
do answer externally; the gate is per model, not per provider.

## Verification

Confirm each candidate model appears in the model-list output for the
respective provider. If a hardcoded name is missing, mark it stale and
recommend filing an issue at the opencode.ai repository.
