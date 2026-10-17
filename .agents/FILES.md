# FILES.md

| What | Where |
| ---- | ----- |
| Extension entry / virtual model + commands | `index.ts` |
| Lint + format config (gts rules over repo house style) | `eslint.config.js` |
| Formatter options (house style: tabs, 120 cols, double quotes) | `.prettierrc.json` |
| tsconfig used for type-aware lint (covers `src/` + `tests/`) | `tsconfig.eslint.json` |
| Lint / format tasks | `.config/mise/conf.d/ts.toml` |
| Routing (`decide`) | `src/core/routing.ts` |
| Failure assessment, blocking and crash recording (`assessFailure`, `observeUnretriedFailure`) | `src/core/failure.ts` |
| Router decision vocabulary (`Decision`, `DecisionOutcome`) | `src/core/decision.ts` |
| Dispatch (`buildRoute`, pi `ModelRoute` construction) | `src/build-route.ts` |
| Reasoning-level resolution (`resolveDispatchLevel`) | `src/core/dispatch.ts` |
| Host boundary ports (`ModelRegistryPort`, `AvailabilityPort`, `ClassifierPort`, `NotifyPort`, `RouterRegistryPort`) | `src/core/ports.ts` |
| Classification (`classifyError`) | `src/core/classify.ts` |
| Local-classifier provider registration | `src/local-classifier.ts` |
| System One classifier transport (switchback's own) | `src/core/systemone.ts` |
| Catalog validity (`resolveFallbacks`) | `src/core/availability.ts` |
| Config loader (YAML) | `src/core/config.ts` |
| Config editor (comment-preserving YAML round-trip) | `src/core/config-editor.ts` |
| Interactive config dialogue (`/switchback-config`) | `src/dialogue.ts` |
| …its shared session, screen-title and prompt primitives | `src/dialogue-ui.ts` |
| …its decision-model wizard (`decisionModels`, provider/baseUrl/model prompts, API-key step) | `src/dialogue-classifier.ts` |
| Shared types | `src/core/types.ts` |
| Atomic store writes (per-write staging path, retried rename) | `src/core/atomic-write.ts` |
| Blocked-until store (atomic) | `src/core/state.ts` |
| Crash store + Tier 2b annotation cache | `src/core/crashes.ts` |
| Encrypted API-key store (DPAPI at rest) | `src/secrets.ts` |
| Simulate mode (fixtures + replay) | `src/core/simulate.ts` |
| Shipped fallback config | `switchback.yaml`, `switchback.yaml.example` |
| Simulate fixtures | `switchback.simulate.json` |
| Tests | `tests/*.test.ts` |
| Command-output snapshots | `tests/__snapshots__/commands.test.ts.snap` |
| User-facing docs (quickstart, commands, config pointer) | `README.md` |
| Docs site — User guide (Home, Configuration, Configuration dialogue, Classifier, License) | `docs/{index,configuration,configuration-dialogue,classifier,license}.md` |
| Docs site — Development (Overview, Architecture, Crash collection, Versioning, Issue tracking, Contributing) | `docs/{development,architecture,crash-collection,versioning,issue-tracking,contributing}.md` |
| Docs site config | `mkdocs.yml` |
| README banner (hero) | `assets/readme/banner.svg` |
| Contribution guidelines (canonical) | `docs/contributing.md` (root `CONTRIBUTING.md` redirects) |
| Issue tracker (embedded Dolt) | `.beads/` (gitignored data; tracked config only) |
| Local skill catalog (machine-local) | `.agents/skills/` (gitignored) |
| Implementation plans (gitignored working artifacts) | `.agents/plans/` |
| DOX hierarchy | root `AGENTS.md` + `.agents/{ONBOARDING,POLICIES,FILES,TOOLS,HISTORY,MAINTENANCE}.md` + `src/AGENTS.md` + `src/core/AGENTS.md` + `tests/AGENTS.md` |
