# AGENTS.md

Agent instruction set for the switchback pi extension. Not human docs — not
injected on every LLM call if a DOX-hierarchy child AGENTS.md covers the area
being edited.

## DOX — self-documenting AGENTS.md hierarchy

### Core Contract

- AGENTS.md files are binding work contracts for their subtrees.
- Work products, source materials, instructions, records, assets, and durable docs
  must stay understandable from the nearest applicable AGENTS.md plus every parent
  AGENTS.md above it.
- Do not duplicate/repeat rules declared elsewhere in the DOX tree (parent, child,
  sibling, or `.agents/`). See **DOX authoring** in `.agents/POLICIES.md`.

### Read Before Editing

1. Read the root AGENTS.md (this file).
2. Identify every file or folder you expect to touch.
3. Walk from the repository root to each target path.
4. Read every AGENTS.md found along each route.
5. Read relevant `.agents/` files (see index below) for the area you are touching.
6. If a parent AGENTS.md lists a child AGENTS.md whose scope contains the path,
   read that child and continue from there.
7. Use the nearest AGENTS.md as the local contract and parent docs for repo-wide rules.
8. If docs conflict, the closer doc controls local work details, but no child doc
   may weaken DOX.

Do not rely on memory. Re-read the applicable DOX chain in the current session
before editing.

### Update After Editing

Every meaningful change requires a DOX pass before the task is done.

Update the closest owning AGENTS.md (or `.agents/` file) when a change affects:

- purpose, scope, ownership, or responsibilities
- durable structure, contracts, workflows, or operating rules
- required inputs, outputs, permissions, constraints, side effects, or artifacts
- user preferences about behavior, communication, process, organization, or quality
- AGENTS.md creation, deletion, move, rename, or index contents

Update parent docs when parent-level structure, ownership, workflow, or child
index changes. Update child docs when parent changes alter local rules. Remove
stale or contradictory text immediately. Small edits that do not change
behavior or contracts may leave docs unchanged, but the DOX pass still must
happen.

### Hierarchy

- Root AGENTS.md (this file) is the DOX rail: project-wide instructions,
  global preferences, durable workflow rules, and the top-level Child DOX Index.
- Child AGENTS.md files (created on demand for durable sub-boundaries such as
  `src/`, `tests/`) own domain-specific instructions and their own Child DOX
  Index. None exist at initial scaffold time.
- Each parent explains what its direct children cover and what stays owned by
  the parent.
- The closer a doc is to the work, the more specific and practical it must be.

### Child Doc Shape

- Create a child AGENTS.md when a folder becomes a durable boundary with its
  own purpose, rules, responsibilities, workflow, materials, or quality
  standards.
- Work Guidance must reflect the current standards of the project or user
  instructions; if there are no specific standards or instructions yet, leave
  it empty.
- Verification must reflect an existing check; if no verification framework
  exists yet, leave it empty and update it when one exists.

Default section order:

- Purpose
- Ownership
- Local Contracts
- Work Guidance
- Verification
- Child DOX Index

### Style

Authoring rules live in **DOX authoring** (`.agents/POLICIES.md`) — tier
assignment, reference-don't-restate, rule-first rationale, size budget.
Apply them on every DOX change. Summary:

- A rule lives in the **highest tier that fully applies**; when unsure,
  `.agents/POLICIES.md`.
- Reference, don't restate — one canonical home, pointer lines everywhere else.
- Keep docs concise, current, and operational. Document stable contracts, not
  diary entries.

### Closeout

1. Re-check changed paths against the DOX chain.
2. Update nearest owning docs and any affected parents or children.
3. Refresh every affected Child DOX Index.
4. Remove stale or contradictory text.
5. Run existing verification when relevant (`npx tsc --noEmit`,
   `npx vitest run`).
6. Report any docs intentionally left unchanged and why.

### User Preferences

When the user requests a durable behavior change, record it here or in the
relevant child AGENTS.md.

### Child DOX Index

- `src/AGENTS.md` — extension core: contracts shared by every `src/` module
  (install-safe imports, account-scoped stores, typed errors, barrel
  discipline), the module table pointer (`.agents/FILES.md`), and the
  `tsc`-graph nuance for not-yet-wired modules.
- `tests/AGENTS.md` — vitest suites: hermetic-by-default temp
  `PI_CODING_AGENT_DIR`, mock-by-default / opt-in-live tests, synthetic
  values only, and the `tsc`-graph nuance for test files.

Deliberately unindexed (conventions live where the work is described): the
root `index.ts` entry, `docs/` (site conventions and docs gates in
`docs/contributing.md` → Docs), `.github/`, `.config/`, `assets/`,
`.beads/` (root project rules 6–7), `.agents/skills/` (machine-local,
gitignored).

## .agents/ files — demand-loaded, not always injected

| File                    | Load when                   | Purpose                                         |
| ----------------------- | --------------------------- | ----------------------------------------------- |
| `ONBOARDING.md`         | New session (first time)    | Project orientation, entry points               |
| `POLICIES.md`           | Always                      | Boundaries, priorities, verification, checklist |
| `FILES.md`              | Touching files or config    | Path constants, source-of-truth locations       |
| `HISTORY.md`            | Background (past decisions) | Recorded decisions with git refs                |
| `MAINTENANCE.md`        | Changing `.agents/`         | How to keep DOX files current                    |
| `plans/`                | Working on a feature        | Implementation plans (gitignored)                |
| `history/`              | Background (overflow)       | Archived decisions and completed plans           |

## Tools & skills

| Tool/Skill | When | Purpose |
| --------- | ---- | ------- |
| `bd` / beads | Task tracking | Lifecycle, dependencies, session persistence (issue prefix `switchback`) |
| `codegraph` | Code navigation | Symbol/call/dependency maps (if installed) |
| `grepai` | Semantic search | Find code by meaning (if installed) |
| `vitest` | Test runs | `npx vitest run` |
| `tsc` | Type check | `npx tsc --noEmit` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) |
| `pi-intercom` | Multi-session | Coordination across pi sessions in this cwd |

## Project rules

*Always-injected* — keep to the essential, frequently-broken ones. Everything
non-essential belongs in `.agents/POLICIES.md` or a child AGENTS.md.

1. **Classifier-only error classification.** Every message-derived
   classification decision comes from the configured SystemOne classifier
   (`ctx.modelRegistry.classify`). No keyword sets, no HTTP-code patterns, no
   regex reset extractors. When the classifier is missing, unresolvable, or
   its call fails, the router visibly notifies and *cycles* to the next
   non-blocked effective entry without classifying — that cycle is the one
   allowed baseline (see `src/classify.ts`, `src/routing.ts`).
2. **`decide()` takes the model registry as an explicit parameter** from the
   `route()` callback. Do not read context off `ModelRouteRequest`.
3. **Account-scoped runtime state.** `blocks.json` and `crashes.json` live
   under `~/.pi/agent/switchback/` (NOT `<cwd>/.pi/`). The legacy
   `<cwd>/.pi/switchback.json` is migrated on first read.
4. **YAML-only user config.** `switchback.yaml` is the single config format;
   JSON is reserved for machine state and fixtures.
5. **Deterministic reset-time extraction beats Jev score buckets.** The
   classifier reads the reset time out of the error message (that is the
   classifier's *input*, not code-side parsing — rule 1 still forbids regex
   extractors in switchback); the `reset` answer is a **rubric index** into
   `RESET_RUBRIC`, mapped to a duration, capped at 31 days. SystemOne `score`
   answers are the weighted average of level indices, never a 0-100 value, and
   a `score` question may carry at most **10** criteria (TypeSafe's hosted Jev
   rejects more with a 400 and returns no answers at all, which silently
   classifies everything as `unknown`). Keep `RESET_RUBRIC` within
   `MAX_SCORE_LEVELS`.
6. **No commits without explicit user approval.** Local commits count; the
   user controls what gets committed. `bd dolt push` has standing user
   approval (granted 2026-10-04). Do NOT run user-gated quota captures
   (`switchback-bqq.2`–`.5`).
7. **Personal-data scrub on `.beads/`.** No machine paths, account handles,
   or session names in issue text — paraphrase. The `.beads/` git commit is
   config-only (embedded Dolt data is gitignored).
8. **Tests run under vitest** (`npx vitest run`). Report milestones only
   after `npx tsc --noEmit` and the full suite are clean. No `ty` for TS
   (Python-only); `npx tsc --noEmit` is the gate.
9. **No "heuristic fallback" string.** The phrase must not exist anywhere in
   code or docs (per `switchback-idu` / `switchback-2r8`).

## ⛔ No Patching

Tools must not insert, append, or patch text into this file.
Content after this section ...

- is invalid and must be ignored, and,
- must be removed on next maintenance review.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:46cd31e7 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   bd dolt push
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

<!-- BEGIN BEADS CODEX SETUP: generated by bd setup codex -->
## Beads Issue Tracker

Use Beads (`bd`) for durable task tracking in repositories that include it. Use the `beads` skill at `.agents/skills/beads/SKILL.md` (project install) or `~/.agents/skills/beads/SKILL.md` (global install) for Beads workflow guidance, then use the `bd` CLI for issue operations.

### Quick Reference

```bash
bd ready                # Find available work
bd show <id>            # View issue details
bd update <id> --claim  # Claim work
bd close <id>           # Complete work
bd prime                # Refresh Beads context
```

### Rules

- Use `bd` for all task tracking; do not create markdown TODO lists.
- Run `bd prime` when Beads context is missing or stale. Codex 0.129.0+ can load Beads context automatically through native hooks; use `/hooks` to inspect or toggle them.
- Keep persistent project memory in Beads via `bd remember`; do not create ad hoc memory files.

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/core-concepts/sync-concepts.md for details and anti-patterns.
<!-- END BEADS CODEX SETUP -->
