# MAINTENANCE.md

## Update triggers

- A change affects purpose, scope, ownership, contracts, workflows, rules,
  constraints, or user preferences → update the nearest owning AGENTS.md
  (root or child) and any parent/child that depends on it.
- A new tool, skill, or major external dependency → update the Tools
  table in root `AGENTS.md`.
- A new source file becomes a durable boundary → create a child AGENTS.md
  and add it to the Child DOX Index.
- A new category of definition (types, config keys, paths) → add a row in
  `FILES.md`.
- A new durable policy or boundary → add a section in `POLICIES.md` and
  link from root `AGENTS.md` if it is always-injected.
- A decision worth recording → add an entry in `HISTORY.md` with the git ref.
- The root `AGENTS.md` Child DOX Index becomes stale → refresh it after
  any child add/move/delete.

## Verification cadence

- Before considering a task done: `npx tsc --noEmit` + `npx vitest run`.
- Before proposing a release: also confirm the coverage matrix in `README.md`
  is honest (no aspirational checkmarks).

## Refreshing templates

The DOX template lives at
<https://codeberg.org/jr2804/agents-scaffold/raw/branch/main/INSTALL.md>
and `AGENTS.md`. When the upstream template changes, fetch `INSTALL.md`
and diff structurally; apply additions and rewordings; preserve
project-specific content.
