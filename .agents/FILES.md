# FILES.md

| What | Where |
| ---- | ----- |
| Extension entry / virtual model + commands | `index.ts` |
| Routing (`decide`) | `src/routing.ts` |
| Dispatch (`buildRoute`, reasoning-level resolution) | `src/build-route.ts` |
| Classification (`classifyError`) | `src/classify.ts` |
| Local-classifier provider registration | `src/local-classifier.ts` |
| System One classifier transport (switchback's own) | `src/systemone.ts` |
| Catalog validity (`resolveFallbacks`) | `src/availability.ts` |
| Config loader (YAML) | `src/config.ts` |
| Config editor (comment-preserving YAML round-trip) | `src/config-editor.ts` |
| Interactive config dialogue (`/switchback-config`) | `src/dialogue.ts` |
| Shared types | `src/types.ts` |
| Blocked-until store (atomic) | `src/state.ts` |
| Crash store + Tier 2b annotation cache | `src/crashes.ts` |
| Encrypted API-key store (DPAPI at rest) | `src/secrets.ts` |
| Simulate mode (fixtures + replay) | `src/simulate.ts` |
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
| DOX hierarchy | root `AGENTS.md` + `.agents/{ONBOARDING,POLICIES,FILES,HISTORY,MAINTENANCE}.md` |
