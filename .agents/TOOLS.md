# TOOLS.md

Inventory of development-time tooling: CLIs, MCP servers, skills, runtimes,
and project scripts. Each tool appears exactly once, with a short
when-to-use note. Keep the tables current — this is not a historical log.

| Tool/Skill | When | Purpose |
| ---------- | ---- | ------- |
| `bd` / beads | Task tracking | Lifecycle, dependencies, session persistence (issue prefix `switchback`) |
| `codegraph` | Code navigation | Symbol/call/dependency maps (if installed) |
| `grepai` | Semantic search | Find code by meaning (if installed) |
| `vitest` | Test runs | `npx vitest run` |
| `gts` (mise `lint-ts` / `format-ts`) | Before committing TS changes | Lint + formatting; see `.agents/POLICIES.md` → Verification. On this Windows checkout `mise run lint-ts` fails (the `eslint` its `gts` spawns is not on `PATH`) — run `npx eslint .` / `npx eslint . --fix` instead. |
| `tsc` | Type check | `npx tsc --noEmit` (strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`) |
| `pi-intercom` | Multi-session | Coordination across pi sessions in this cwd |
