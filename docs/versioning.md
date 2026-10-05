# Versioning

CalVer `YYYY.0M.N` ([calver.org](https://calver.org) scheme, zero-padded month).
`N` starts at 1 each month and increments per release. Example: `v2026.10.1`
is the first release of October 2026.

- **Tags are authoritative.** `git tag --list 'v*'` and the GitHub
  Releases page are the source of truth. `package.json`'s `version`
  field is set ONCE at scaffold time and is **never updated by the
  release workflow** (the workflow explicitly never creates commits; this
  is what prevents the tag-push self-loop). A local checkout may show
  `package.json` lagging behind the latest tag (e.g. `v2026.10.3` release
  with `package.json` still reading `2026.10.1`). When in doubt, query
  the tag list, not the file.
- **Auto-tag + auto-release** on every push to `main` via
  `.github/workflows/calver-release.yml`. The workflow computes the
  next tag for the current month, tags `HEAD`, and creates a release
  with auto-generated notes. It does NOT create commits (no
  `package.json` bumping), so it cannot retrigger itself.
- Branch filter is `[main]`. Tag pushes are not retried.
- Tag-push races (two pushes in the same month) are tolerated via an
  exists-check that exits 0 silently.
