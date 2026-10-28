# FILES.md

| What | Where |
| ---- | ----- |
| Workspace layout (three packages, npm workspaces) | `package.json` (`workspaces`), `packages/{core,pi,opencode}/package.json` |
| pi extension entry / virtual model + commands | `packages/pi/index.ts` |
| Core package surface (`switchback-core`) | `packages/core/src/index.ts` |
| pi package surface (`pi-switchback` barrel) | `packages/pi/src/index.ts` |
| OpenCode adapter (provider publication, RPC, commands) | `packages/opencode/src/index.ts` |
| OpenCode TUI half (toast sink, `/switchback-config` slash command) | `packages/opencode/src/tui.ts` |
| OpenCode GUI half (desktop bundle entry, toast sink, command) | `packages/opencode/src/gui.tsx` |
| OpenCode GUI host-free logic (dialog adaptation, variants, attach order) | `packages/opencode/src/gui-support.ts` |
| OpenCode GUI bundle build (Vite preset, `dist/gui-experimental.cjs`) | `packages/opencode/vite.config.ts` |
| OpenCode guided config menu (client of the layer-1 grammar) | `packages/opencode/src/tui-guide.ts` |
| `/switchback-config` grammar + its single writer | `packages/opencode/src/config-command.ts` |
| OpenCode `unknown`-wire readers (notice, edit, guide state) | `packages/opencode/src/rpc.ts` |
| OpenCode notice channel + sink refcount | `packages/opencode/src/notices.ts` |
| Picker fuzzy matching (OpenCode TUI has no `fuzzyFilter`) | `packages/opencode/src/fuzzy.ts` |
| OpenCode router↔route seam (bridge, `globalThis` symbol) | `packages/opencode/src/bridge.ts` |
| OpenCode core `decide()` wiring, credentials, notifications | `packages/opencode/src/router.ts` |
| OpenCode delegating route (physical dispatch, in-flight failover, realm localization) | `packages/opencode/src/route.ts` |
| OpenCode chain → physical entry resolution | `packages/opencode/src/catalog.ts` |
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
| System One classifier transport (delegates to `@typesafe-ai/sdk`) | `packages/core/src/systemone.ts` |
| Catalog validity (`resolveFallbacks`) | `packages/core/src/availability.ts` |
| Config loader (YAML) | `packages/core/src/config.ts` |
| Config editor (comment-preserving YAML round-trip) | `packages/core/src/config-editor.ts` |
| Interactive config dialogue (`/switchback-config`) | `packages/pi/src/dialogue.ts` |
| …its shared session, screen-title and prompt primitives | `packages/pi/src/dialogue-ui.ts` |
| …its decision-model wizard (`decisionModel:` address picker, `decisionModels` map entry menu for rename/connection/probe/delete, `baseUrl` + API-key steps) | `packages/pi/src/dialogue-classifier.ts` |
| Shared types | `packages/core/src/types.ts` |
| Atomic store writes (per-write staging path, retried rename) | `packages/core/src/atomic-write.ts` |
| Blocked-until store (atomic) | `packages/core/src/state.ts` |
| Manual disable list (atomic, `disabled.json`) | `packages/core/src/state.ts` |
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
