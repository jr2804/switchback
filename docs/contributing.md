# Contributing

## Development setup

See [Development → From source](development.md#from-source) for the full
checkout-and-run flow (clone, `npm install`, dev mode, daily-driver
junction, first-run verification).

## Verification gate

Before considering any task done:

```bash
npx tsc --noEmit      # strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes
mise run lint-ts      # gts (ESLint + Prettier check) — must report nothing
npx vitest run        # 303 passing + 11 opt-in
```

All three must be clean. Do not report a milestone until all three pass.
`mise run format-ts` applies the autofixes (`gts fix`); run it before
`lint-ts` when a gate fails rather than hand-formatting, so the repo's
house style — tabs, 120 columns, double quotes — stays authoritative.

Two gates do not cover everything, and both gaps have bitten:

- **`tsc --noEmit` only sees the root `index.ts` graph** (`tsconfig.json`
  sets `include: ["index.ts"]`). Test files and any not-yet-wired module are
  outside it, so a broken import there passes the type gate and fails only in
  vitest. `tests/barrel.test.ts` exists because nothing else loads
  `src/index.ts`.
- **A formatter can push a module over the ~500-code-line limit** without
  adding a single symbol. `src/routing.ts` went 458 → 605 that way.

## Style

- Strict types: no `any`, no `hasattr` / `isinstance` duck-typing,
  concrete types everywhere.
- No defensive-coding patterns (`try { ... } catch {}` swallow, import
  try/except, `hasattr` guards). Fix root causes.
- No keyword sets, no HTTP-code patterns, no regex reset extractors in
  the classifier path. The configured SystemOne classifier is the single
  source of truth for message-derived decisions.
- No prompt criteria derived from collected provider traffic either
  (root `AGENTS.md` project rule 7): a captured error message is a test
  input, never a reason to change `JEV_QUESTIONS`, `RESET_RUBRIC` or a
  threshold. Prompt changes are justified by a general property of the
  question or the protocol.
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
