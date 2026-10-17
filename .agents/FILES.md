# FILES.md

| What | Where |
| ---- | ----- |
| Workspace layout (three packages, npm workspaces) | `package.json` (`workspaces`), `packages/{core,pi,opencode}/package.json` |
| pi extension entry / virtual model + commands | `packages/pi/index.ts` |
| Core package surface (`switchback-core`) | `packages/core/src/index.ts` |
| pi package surface (`pi-switchback` barrel) | `packages/pi/src/index.ts` |
| OpenCode V2 plugin (`retry` hook routing, `/switchback` + `/switchback-unblock`) | `packages/opencode/src/index.ts` |
| Lint + format config (gts rules over repo house style) | `eslint.config.js` |
| Formatter options (house style: tabs, 120 cols, double quotes) | `.prettierrc.json` |
| tsconfig used for type-aware lint (covers `packages/` + `tests/`) | `tsconfig.eslint.json` |
| Lint / format tasks | `.config/mise/conf.d/ts.toml` |
| Routing (`decide`) | `packages/core/src/routing.ts` |
| Failure assessment, blocking and crash recording (`assessFailure`, `observeUnretriedFailure`) | `packages/core/src/failure.ts` |
| Router decision vocabulary (`Decision`, `DecisionOutcome`) | `packages/core/src/decision.ts` |
| Dispatch (`buildRoute`, pi `ModelRoute` construction) | `packages/pi/src/build-route.ts` |
| Reasoning-level resolution (`resolveDispatchLevel`) | `packages/core/src/dispatch.ts` |
| Host boundary ports (`ModelRegistryPort`, `AvailabilityPort`, `ClassifierPort`, `NotifyPort`, `RouterRegistryPort`, `ThinkingSupportPort`) | `packages/core/src/ports.ts` |
| Classification (`classifyError`) | `packages/core/src/classify.ts` |
| Local-classifier provider registration | `packages/pi/src/local-classifier.ts` |
| System One classifier transport (switchback's own) | `packages/core/src/systemone.ts` |
| Catalog validity (`resolveFallbacks`) | `packages/core/src/availability.ts` |
| Config loader (YAML) | `packages/core/src/config.ts` |
| Config editor (comment-preserving YAML round-trip) | `packages/core/src/config-editor.ts` |
| Interactive config dialogue (`/switchback-config`) | `packages/pi/src/dialogue.ts` |
| …its shared session, screen-title and prompt primitives | `packages/pi/src/dialogue-ui.ts` |
| …its decision-model wizard (`decisionModels`, provider/baseUrl/model prompts, API-key step) | `packages/pi/src/dialogue-classifier.ts` |
| Shared types | `packages/core/src/types.ts` |
| Atomic store writes (per-write staging path, retried rename) | `packages/core/src/atomic-write.ts` |
| Blocked-until store (atomic) | `packages/core/src/state.ts` |
| Crash store + Tier 2b annotation cache | `packages/core/src/crashes.ts` |
| Encrypted API-key store (DPAPI at rest) | `packages/pi/src/secrets.ts` |
| Simulate mode (fixtures + replay) | `packages/core/src/simulate.ts` |
| Shipped fallback config | `switchback.yaml`, `switchback.yaml.example` |
| Simulate fixtures | `switchback.simulate.json` |
| Tests | `tests/*.test.ts` |
| Command-output snapshots | `tests/__snapshots__/commands.test.ts.snap` |
| CalVer release tagging (tag + GitHub Release on every push to main) | `.github/workflows/calver-release.yml` |
| npm publishing (tag push → `switchback-core`, `pi-switchback`, `opencode-switchback`) | `.github/workflows/publish-npm.yml`, `scripts/set-package-version.mjs` |
| User-facing docs (quickstart, commands, config pointer) | `README.md` |
| Docs site — User guide (Home, Configuration, Configuration dialogue, Classifier, License) | `docs/{index,configuration,configuration-dialogue,classifier,license}.md` |
| Docs site — Development (Overview, Architecture, Crash collection, Versioning, Issue tracking, Contributing) | `docs/{development,architecture,crash-collection,versioning,issue-tracking,contributing}.md` |
| Docs site config | `mkdocs.yml` |
| README banner (hero) | `assets/readme/banner.svg` |
| Contribution guidelines (canonical) | `docs/contributing.md` (root `CONTRIBUTING.md` redirects) |
| Issue tracker (embedded Dolt) | `.beads/` (gitignored data; tracked config only) |
| Local skill catalog (machine-local) | `.agents/skills/` (gitignored) |
| Implementation plans (gitignored working artifacts) | `.agents/plans/` |
| DOX hierarchy | root `AGENTS.md` + `.agents/{ONBOARDING,POLICIES,FILES,TOOLS,HISTORY,MAINTENANCE}.md` + `packages/{core,pi,opencode}/AGENTS.md` + `tests/AGENTS.md` |
