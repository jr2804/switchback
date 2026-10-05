# POLICIES.md

## Boundaries

- **Classifier-only error classification** — see root AGENTS.md §1 and
  `src/classify.ts`. No per-provider pattern matchers, no keyword sets, no
  regex reset extractors. The configured SystemOne classifier is the single
  source of truth for message-derived decisions.
- **No commits without explicit user approval.** `bd dolt push` has standing
  approval (granted 2026-10-04); nothing else does.
- **No user-gated captures autonomously.** Do not run `switchback-bqq.2`–`.5`
  quota-burning probes.
- **Personal-data scrub on `.beads/`** — paraphrase machine paths, account
  handles, session names. The `.beads/` git commit is config-only; embedded
  Dolt data is gitignored.

## Priorities

1. Architectural integrity and root-cause fixes over surface workarounds.
2. Single sources of truth over mirrored or scattered logic.
3. Validation (tests, type check, logs) as a hard gate before considering
   work complete.
4. Type-rigor: concrete types, no `any`, no `hasattr`/`isinstance`
   duck-typing in TS source. `tsconfig` is `strict` +
   `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`.
5. Concise, operational docs over walls of text.

## Verification

- Type check: `npx tsc --noEmit` (must be clean).
- Tests: `npx vitest run` (must be all green; report milestones only after
  both pass).
- Manual end-to-end: `pi --extension ./index.ts --model switchback/auto -p "ping"`.
- Crash corpus honesty: the coverage matrix in `README.md` distinguishes raw
  observations from shipped fixtures; do not conflate.

## DOX authoring

- A rule lives in the **highest tier that fully applies**. Tiers, from broad
  to specific: root `AGENTS.md` (project-wide, always-injected) →
  `.agents/POLICIES.md` (boundaries / priorities / verification) → child
  `AGENTS.md` (domain-specific) → subtree `AGENTS.md`. When unsure, default
  to `.agents/POLICIES.md`.
- **Reference, don't restate.** One canonical home; other docs point to it.
- **Rule-first rationale.** State the rule, then the why. Cut filler.
- **Size budget.** Keep each doc tight. Split or move detail rather than
  growing a doc past its purpose.
- Document stable contracts, not diary entries. Move session history to
  `.agents/HISTORY.md` (or `git log`).

## Checklist (before considering a task done)

1. `npx tsc --noEmit` clean.
2. `npx vitest run` green.
3. Relevant docs updated (DOX pass).
4. No defensive-coding patterns introduced (`try { ... } catch {}` swallow,
   `hasattr` guards, `import` try/except).
5. No fabricated wrappers, aliases, or compat claims to dodge honest gaps.
6. If a bead exists for the work, status is correct (`bd update <id> --claim`
   before starting, `bd close <id>` after verification).
