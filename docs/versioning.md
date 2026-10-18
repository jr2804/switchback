# Versioning

CalVer `YYYY.0M.N` ([calver.org](https://calver.org) scheme, zero-padded month).
`N` starts at 1 each month and increments per release. Example: `v2026.10.1`
is the first release of October 2026.

- **Tags are authoritative.** `git tag --list 'v*'` and the GitHub
  Releases page are the source of truth. The `version` fields in the
  workspace manifests are set ONCE at scaffold time and are **never updated
  by the release workflow** (the workflow explicitly never creates commits;
  this is what prevents the tag-push self-loop). A local checkout may show
  a manifest lagging behind the latest tag (e.g. `v2026.10.3` release with
  `package.json` still reading `2026.10.1`). When in doubt, query
  the tag list, not the file.
- **Auto-tag + auto-release** on every push to `main` via
  `.github/workflows/calver-release.yml`. The workflow computes the
  next tag for the current month, tags `HEAD`, creates a release
  with auto-generated notes, and then publishes to npm by calling
  `publish-npm.yml` (see below). It does NOT create commits (no
  `package.json` bumping), so it cannot retrigger itself.
- Branch filter is `[main]`. Tag pushes are not retried.
- Tag-push races (two pushes in the same month) are tolerated via an
  exists-check that exits 0 silently.

## Publishing

Three npm packages are released from the version tag:

| Package | What it is |
| ------- | ---------- |
| `switchback-core` | The host-agnostic decision core (`packages/core`). |
| `pi-switchback` | The pi extension (`packages/pi`). |
| `opencode-switchback` | The OpenCode V2 plugin (`packages/opencode`). |

`.github/workflows/publish-npm.yml` publishes the tag. It is a **reusable
workflow**: `calver-release.yml` calls it with the tag it just created, and it
is *not* started by the tag push. That call is required, not a shortcut — a tag
pushed with the default `GITHUB_TOKEN` does not start another workflow, so
`on: push: tags` alone would leave every release sitting unpublished. The
`push: tags` trigger is still declared for tags pushed by a human.

It type-checks and tests the tagged tree, then publishes `switchback-core`
first and the two adapters after it, so a plugin is never released pointing at
a core version that is not on the registry yet. Adapters publish in parallel
(`fail-fast: false`), and every publish carries a provenance attestation
automatically.

The tag is the only version source. `scripts/set-package-version.mjs`
writes the tag's `YYYY.0M.N` into the manifests **inside the runner**,
where it is used for the publish and then discarded - the "no workflow
creates a commit" rule above still holds, and no manifest in git is
rewritten. A tag that is not CalVer fails the stamp step rather than
publishing a guessed version.

Publishing authenticates by **npm trusted publishing** (OIDC,
[docs.npmjs.com/trusted-publishers](https://docs.npmjs.com/trusted-publishers)),
not by a token: there is no `NPM_TOKEN` secret. The publish jobs grant
`id-token: write`, and the npm CLI exchanges a short-lived GitHub OIDC token
for publish rights. This needs a one-time registration on npmjs.com for each
package (Settings  Trusted Publisher, GitHub Actions):

- repository `jr2804/switchback`, with **two** entries per package: one
  naming workflow filename `calver-release.yml` (npm validates the *calling*
  workflow for reusable-workflow chains, and that is the caller) and one
  naming `publish-npm.yml` (the direct tag-push and dispatch paths),
- "Allow `npm publish`" ticked - entries created after 2026-09-03 default to
  staged-only publishing,
- the first successful publish must land within two days of creating an
  entry, or the entry expires and must be recreated.

A misconfigured registration (wrong workflow filename, staged-only entry)
fails the run at the publish step with an authentication error instead of
silently skipping the release.

The packages are **source-only**: `files: ["src"]` (plus `index.ts` for
the pi extension) and `exports` point straight at the `.ts` files, which
the host loader type-strips at install time. There is no build step and no
`dist/` in any published tarball (`npm pack --dry-run` shows the exact
file list).

To check a release without publishing, run
`publish-npm.yml` by hand (`workflow_dispatch`, "Actions → publish-npm → Run
workflow"); its `dry_run` input defaults to `true` and adds `--dry-run` to each
publish.

To recover a failed publish, dispatch the same workflow with the tag as its
`tag` input and `dry_run` off. Re-running `calver-release.yml` will not do it:
that workflow sees a `v*` tag already on `HEAD` and exits cleanly without
publishing, so the tag input is the repair path.
