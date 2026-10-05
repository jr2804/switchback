# Issue tracking

Long-horizon work — the classifier-validation backlog, the user-gated
provider captures, drift / bug follow-ups — is tracked with
[beads](https://github.com/gastownhall/beads), a dependency-aware issue
tracker built for multi-session agent work. The tracker lives in
`.beads/` (local, machine-scoped; not shipped in the extension).

## Commands

```bash
bd ready                 # unblocked work
bd list                  # full tree with hierarchy
bd list --all            # full tree including the epic and child issues
bd show switchback-bqq   # one issue in detail
bd update <id> --claim   # claim atomically before starting
bd close <id> --reason "..."   # close with a reason
bd dep cycles            # sanity-check the dep graph
bd export                # export to JSONL
```

## Source of truth

The live board (`bd list --all`) is the single source of truth. This docs
site and the README do not mirror it. The classifier-validation epic is
`switchback-bqq`; a few top-level items (handover record, CI checkout
bump, drift / bug follow-ups) sit alongside it.

## Workflow

1. `bd ready` to find unblocked work.
2. `bd update <id> --claim` to claim atomically before starting.
3. `bd close <id> --reason "..."` after verification.

## User-gated captures

Several backlog items deliberately burn quota to capture real error
shapes (e.g. `switchback-bqq.2`–`.5`). They must only be run by the user,
never autonomously.

## Personal-data scrub

No machine paths, account handles, or session names in issue text —
paraphrase. The `.beads/` git commit is config-only; embedded Dolt data
is gitignored. A `.beads` commit must pass the same scrub gate before it
lands.

## Commits and `bd dolt push`

- No commits without explicit user approval.
- `bd dolt push` has standing user approval (granted 2026-10-04).
