# Contributing to oc-health-sync

## Cutting a release

A release is a single git tag plus the artifacts that the `release.yml` workflow produces from it (image on GHCR, tarball on GitHub Releases).

```bash
# All on main, after a green CI build of the merge commit:
git checkout main && git pull
git tag vX.Y.Z
git push origin vX.Y.Z
gh run watch --exit-status
```

When the workflow finishes green:

- `ghcr.io/dominikx96/oc-health-sync-plugin/mcp-server:vX.Y.Z` exists (also tagged `:latest`).
- A GitHub release `vX.Y.Z` exists with `oc-health-sync-vX.Y.Z.tar.gz` attached.

The VPS upgrade flow lives in `deploy/README.md`.

### Versioning

Semver. Increment:

- **Major** (`v1.0.0`) — breaking change to the iOS ingest contract or the MCP tool/resource surface.
- **Minor** (`v0.2.0`) — new MCP tools, new HealthKit data types, new edge-function endpoints.
- **Patch** (`v0.1.1`) — bug fixes, dependency bumps, observability improvements.

Pre-release suffixes (`v0.1.0-rc1`, `v0.0.1-rehearsal`) are valid tags and trigger the same workflow but are flagged as pre-releases on GitHub.

## Migration discipline

To make `./upgrade.sh --rollback` reliable, every migration must satisfy:

> The previous image version must continue to function correctly against the new schema.

In practice:

- New columns are nullable, or have defaults.
- New tables don't replace old ones.
- View definitions (`CREATE OR REPLACE VIEW`) keep prior columns or add new ones at the end.
- Idempotent: every migration must be re-runnable. Use `CREATE … IF NOT EXISTS` and `CREATE OR REPLACE …` everywhere; the `migrate` entrypoint applies the whole `/release/migrations/` set in lexical order on every invocation.
- Destructive changes (column drops, type narrowing) are split across **two** releases: release N adds the new shape and dual-writes; release N+1 drops the old shape after the operator has confirmed the data is migrated.

If you must ship a migration that violates the rule, mark it explicitly in the release notes:

> ⚠️ No automatic rollback for vX.Y.Z — restore from `pre-upgrade-*.sql.gz`.

## Local development

See the top-level `README.md` for the local-dev loop with `supabase start`. The CI test set mirrors the local one — if `npm test`, `psql -f supabase/tests/*.test.sql`, and `deno test` all pass locally, CI will pass. The SQL test glob now includes `gym_schema.test.sql`, `gym_roles.test.sql`, and `gym_helpers.test.sql`, so gym schema, role-privilege, and helper-function tests run automatically as part of the loop.

## Branching

- `main` — protected; every commit has gone through CI.
- `feature/*` — work branches. CI does **not** run on these by default. To wet-test the workflow on a feature branch, temporarily widen the `branches:` list in `release.yml` and revert before merging.
