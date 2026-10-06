# Contributing

## Development setup

See [Development → From source](development.md#from-source) for the full
checkout-and-run flow (clone, `npm install`, dev mode, daily-driver
junction, first-run verification).

## Verification gate

Before considering any task done:

```bash
npx tsc --noEmit    # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
npx vitest run      # 120 + opt-in
```

Both must be clean. Do not report a milestone until both pass.

## Style

- Strict types: no `any`, no `hasattr` / `isinstance` duck-typing,
  concrete types everywhere.
- No defensive-coding patterns (`try { ... } catch {}` swallow, import
  try/except, `hasattr` guards). Fix root causes.
- No keyword sets, no HTTP-code patterns, no regex reset extractors in
  the classifier path. The configured SystemOne classifier is the single
  source of truth for message-derived decisions.
- Keep docs concise and operational. Reference, don't restate.

## Issue tracking

Long-horizon work is tracked with [beads](https://github.com/gastownhall/beads).
See [Issue tracking](issue-tracking.md) for the workflow, commands, the
personal-data scrub gate, and the no-commit rule. Claim a bead atomically
before starting, close with a reason after verification.

## Commits and pushes

- **No commits without explicit user approval.** Local commits count; the
  user controls what gets committed.
- `bd dolt push` has standing user approval (granted 2026-10-04).
- Do not run `user-gated` captures (e.g. `switchback-bqq.2`–`.5`); they
  burn quota and must only be run by the user.

## Docs

- The site lives under `docs/` (MkDocs Material, `mkdocs.yml`), split
  into **User guide** and **Development**.
- Update `docs/` and `README.md` together when behavior or contracts
  change.
- Docs gates — run before calling a docs change done:
  `mkdocs build --strict` and `mise format-md` (rumdl). The build writes
  `site/`, which is generated output and stays out of commits.
- See `AGENTS.md` and `.agents/MAINTENANCE.md` at the repository root for
  the maintenance triggers and verification cadence.
