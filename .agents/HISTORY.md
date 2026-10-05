# HISTORY.md

Durable decisions, recorded with git refs. Add new entries at the top.
Routine history stays in `git log`; only decisions that changed the
project's direction, contract, or policy belong here.

## 2026-10-04 — agents-scaffold DOX framework install

Installed the [agents-scaffold](https://codeberg.org/jr2804/agents-scaffold)
DOX hierarchy: root `AGENTS.md` (template contract + 9 project rules) plus
`.agents/{ONBOARDING,POLICIES,FILES,HISTORY,MAINTENANCE}.md`. The `.gitignore`
was extended to track `.agents/*.md` and `.agents/history/` while keeping
`.agents/skills/` (machine-local) and `.agents/plans/` (mutable working
artifacts) ignored. Commit: (this commit — fill the hash on a follow-up
update if exact ref is required).

## 2026-10-04 — `switchback-2r8` closed (no-"heuristic-fallback" rule)

Eliminated the phrase "heuristic fallback" from the codebase and docs as a
deliberate anti-pattern next to the classifier-only architecture (per
`switchback-idu` findings). Tracked as `switchback-2r8` (P3, chore, docs+tests).

## 2026-10-04 — `switchback-idu` closed (`MIN_DWELL_MS` enforcement + decide() drift)

Closed the `MIN_DWELL_MS`-not-enforced gap and corrected the `decide()` docblock
to remove the false "success-unblock" claim. `decide()` now enforces
`MIN_DWELL_MS` (30s) for `user`/`direct` routing, reading `lastSwitchAtMs` from
the session branch state. Commits: `ce906a9` (fix), `251e2e8` (README delta).

## 2026-10-04 — Standing `bd dolt push` user approval

User granted standing approval for `bd dolt push` for all future calls.
Separate one-time approvals at the same time: fix `switchback-idu` and fold
`switchback-2r8` in.

## 2026-10-04 — README: single source of truth for the backlog

Replaced the stale "current open backlog" table in `README.md` with a pointer
to `bd list --all` / `bd show switchback-bqq` so the README cannot drift from
the board. Commit: `251e2e8`.

## 2026-10-04 — Classifier-only error classification (locked)

Locked the architecture: every message-derived classification decision comes
from the configured SystemOne classifier (`ctx.modelRegistry.classify`). No
keyword sets, no HTTP-code patterns, no regex reset extractors. The Jev prompt
v1 is LOCKED against 41 passively-collected real error samples; the 42nd
(deliberate zai 401 probe, captured 2026-10-04) is pending live Jev
validation. The repo ships 9 fixture scenarios in `switchback.simulate.json`
representing the distinct shapes observed. Commit: `4915e34` (initial release).
