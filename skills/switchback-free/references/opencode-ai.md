# opencode.ai (opencode, opencode-go)

## Provider split

One opencode.ai account (same API key / login) serves two distinct
providers with dedicated — and possibly different — free-model sets:

| Model prefix   | Service      | Billing       |
| -------------- | ------------ | ------------- |
| `opencode/`    | opencode-zen | pay-per-usage |
| `opencode-go/` | opencode-go  | subscription  |

The same free model name under both prefixes is **two different models**
with separate free quotas — verify and add **both** entries to the
`sb-free` chain. Their access rules differ; see
"Access rules for free models" below.

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

### Access rules for free models

- `opencode-go/*` free models always require an active opencode-go
  subscription, but they run in **any** agent — pi included.
- `opencode/*` (opencode-zen) free models only work **inside OpenCode**,
  not pi: other clients (pi, curl) get `403 FreeTierError`. Keep them in
  `sb-free` — the chain's primary host is OpenCode — but expect pi runs
  to classify, block, and cycle past them (the classifier-given resets
  observed in testing were minutes, not days).

## Verification

Confirm each candidate model appears in the model-list output for the
respective provider. If a hardcoded name is missing, mark it stale and
recommend filing an issue at the opencode.ai repository.
