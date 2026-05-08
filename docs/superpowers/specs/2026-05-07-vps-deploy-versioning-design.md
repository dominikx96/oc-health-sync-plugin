# oc-health-sync — VPS Deploy & Versioning

**Date:** 2026-05-07
**Status:** Approved (brainstorming complete, awaiting implementation plan)
**Author:** Dominik Barcikowski (with Claude)

## Context

The current deploy story (`deploy/README.md`) is fully manual: clone the repo on the VPS, copy `.env.example`, layer our compose overlay on top of upstream Supabase, build the MCP image locally with `docker compose build`, apply migrations with `psql`, run `init-users.sh`, expose via `tailscale serve`. There is no version concept — the VPS runs whatever HEAD happened to be when it was last `git pull`'d, and there is no canonical way to upgrade from one version to another.

This design adds:

- A versioned release artifact for every shipped change.
- A CI pipeline that builds & publishes the artifact only when the test suite is green.
- A scripted, single-command upgrade path on the VPS with a built-in rollback safety net.

The repository is private (`github.com/dominikx96/oc-health-sync-plugin`) and is intended to remain so.

## Goals

1. Every shipped change has a single addressable version (`vX.Y.Z`) covering all three deliverables: MCP server, SQL migrations, `ingest` Edge Function.
2. CI builds and publishes a Docker image to GHCR (private) and a tarball to GitHub Releases — gated on the full test suite passing.
3. The VPS upgrades with one command (`./upgrade.sh vX.Y.Z`) and never needs `git`.
4. A failed upgrade aborts before the running app is touched. A failed-after-restart upgrade has a one-command rollback path and a fresh DB snapshot taken seconds before the change.
5. Two release channels: `master` pushes produce throwaway `:edge`/`:sha-…` images for testing; `v*` tags produce the durable `:vX.Y.Z` + `:latest` images and a GitHub release.

## Non-goals

- Multi-VPS or fleet management. Single personal-test box.
- Auto-update on the VPS (cron, Watchtower, etc.). Manual operator action only.
- CI pushing to the VPS over SSH. The push/pull boundary stays on the operator side.
- Down-migrations. Forward-only migrations + `pg_dump` snapshots are the rollback story.
- Signed images (sigstore, cosign). Out of scope for private personal use.
- Public registries, public docs, or public release pages. Everything stays gated behind the operator's GitHub identity.
- Automating Supabase upstream-stack upgrades. Operator continues to upgrade `~/supabase-base/` by hand.

## Decisions

| | Decision | Rationale |
|---|---|---|
| **Release model** | Push to `master` → image tagged `:edge` + `:sha-${SHA}`. Push tag `v*` → image tagged `:vX.Y.Z` + `:latest`, plus GitHub release with tarball. Same workflow, two trigger blocks. | Clean separation of in-flight vs released code. Lets the VPS pin a specific version without chasing `:latest`, while still allowing edge testing on a sandbox if needed later. |
| **Bundling** | Migrations + `ingest` Edge Function source are baked into the MCP server image at `/release/migrations/` and `/release/functions/ingest/`. | Single source of truth per version. The image *is* the release; image and migrations cannot skew. |
| **Registry** | Private GHCR. VPS authenticates with a read-only `GHCR_PAT`. | Matches "I don't want to share this image" requirement. Repo is already private. |
| **Quality gates** | All tests must pass before publish: `npm run typecheck`, `npm test` (vitest), the SQL schema tests in `supabase/tests/*.test.sql`, and the Deno tests in `supabase/functions/ingest/*.test.ts`. | Tests already exist; gating publishing on them is essentially free. A broken release never lands on GHCR. |
| **Trigger** | Manual `./upgrade.sh vX.Y.Z` on the VPS. CI never touches the VPS. | Personal-test box on a tailnet — friction of one SSH is tiny. Hard wall between public GitHub and private VPS. Same pipeline scales to N boxes later without changing the build side. |
| **Migrations** | Forward-only, idempotent. Run via a one-shot `docker compose run --rm mcp migrate` *before* `up -d`. | Separates "did migrations succeed" from "did app start" in observable, abortable steps. Migration failure leaves the running app untouched. |
| **Rollback** | Pre-upgrade `pg_dump` to `~/backups/pre-upgrade-<timestamp>.sql.gz`. Previous version stashed in `.last-version.bak`. `./upgrade.sh --rollback` re-pulls the previous tag and restarts. | Cheap insurance even with the existing daily backup cron — this snapshot is *fresh*. Rollback covers the schema-compatible case automatically; the snapshot covers everything else. |
| **Distribution** | Each `v*` tag attaches `oc-health-sync-vX.Y.Z.tar.gz` to a GitHub release. Tarball contains `install.sh`, `upgrade.sh`, `docker-compose.mcp.yml`, `init-users.sh`, `.env.example`, `smoke.sh`, and a generated `VERSION` file. | One self-contained artifact per release. VPS never needs `git`. Bootstrap & upgrade use the same artifact shape. |

## Architecture

### Versioned tuple

A version `vX.Y.Z` is the tuple of three things produced from a single commit by a single workflow run:

1. **Docker image** — `ghcr.io/dominikx96/oc-health-sync-plugin/mcp-server:vX.Y.Z` (also tagged `:latest`). Contains the MCP server runtime *and* `/release/migrations/`, `/release/functions/ingest/`, `/usr/local/bin/migrate`. The image name uses the GHCR multi-package pattern (`<owner>/<repo>/<package>`) so that, if a second image is ever needed, it can live alongside this one under the same repo.
2. **Release tarball** — `oc-health-sync-vX.Y.Z.tar.gz` attached to the GitHub release. Contains operator-facing scripts and compose files; no application code.
3. **Git tag** — `vX.Y.Z` on `master`. Provenance.

The VPS pulls `:vX.Y.Z` and downloads the matching tarball; the two are guaranteed to be from the same commit because the workflow generates them in the same job.

### Release channels

| Trigger | Image tags | Tarball | Release |
|---|---|---|---|
| `push: branches: [master]` | `:edge`, `:sha-${SHA:0:7}` | none | none |
| `push: tags: ['v*']` | `:vX.Y.Z`, `:latest` | yes | yes (GitHub release with tarball) |

The VPS only ever uses `:vX.Y.Z` tags. `:edge` and `:sha-…` exist for local sandbox use, not VPS deployment.

### Topology after deploy (unchanged from current)

```
┌──────────┐  Tailscale   ┌──────────────────────────────────────────┐
│  iPhone  │─────────────▶│           VPS (tailnet only)             │
└──────────┘              │                                          │
                          │  ┌──────────────────────────────────┐    │
   ┌──────────────┐       │  │ Supabase upstream compose        │    │
   │ MCP client   │──────▶│  │  + our overlay (mcp-server)      │    │
   └──────────────┘       │  │                                  │    │
                          │  │  Image source: GHCR (vX.Y.Z)     │    │
                          │  └──────────────────────────────────┘    │
                          │  ~/oc-health-sync/  (extracted tarball)  │
                          │  ~/supabase-base/   (upstream compose)   │
                          │  ~/backups/         (snapshots)          │
                          └──────────────────────────────────────────┘
```

This design does not change topology, networking, or secret handling. It changes **how images and scripts arrive on the VPS** and **how the VPS moves between versions**.

## Components

### Modified: `mcp-server/Dockerfile`

The build stage is unchanged. The runtime stage gains three additional `COPY` lines:

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY mcp-server/package.json mcp-server/package-lock.json* ./
RUN npm ci
COPY mcp-server/ .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache postgresql-client bash
COPY mcp-server/package.json mcp-server/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist                     ./dist
COPY supabase/migrations                        /release/migrations
COPY supabase/functions/ingest                  /release/functions/ingest
COPY mcp-server/scripts/migrate.sh              /usr/local/bin/migrate
RUN chmod +x /usr/local/bin/migrate
EXPOSE 3737
CMD ["node", "dist/index.js"]
```

`postgresql-client` is added so `migrate` can run `psql` against the DB. The build context moves from `mcp-server/` to the repo root so we can `COPY supabase/...`; this means:

- The existing `mcp-server/.dockerignore` is no longer authoritative. A new top-level `.dockerignore` is added that excludes `node_modules/`, `supabase/.branches/`, `supabase/.temp/`, `_legacy/`, `agent_example/`, `skill_example/`, `docs/`, `.git/`, `.github/`, `deploy/.env`, and any other build noise. Only `mcp-server/`, `supabase/migrations/`, and `supabase/functions/ingest/` are needed inside the build context.
- The workflow `docker buildx build` step is invoked from the repo root with `-f mcp-server/Dockerfile`.

### New: `mcp-server/scripts/migrate.sh`

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${MCP_DATABASE_URL:?MCP_DATABASE_URL must be set}"

# Migrations are required to be idempotent (CREATE … IF NOT EXISTS / CREATE OR REPLACE).
# We apply them in lexical order against $MCP_DATABASE_URL.
for f in /release/migrations/*.sql; do
  echo "Applying $(basename "$f")..."
  psql "$MCP_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done
echo "All migrations applied."
```

The MCP server's runtime user (`read_user`) does not have schema-modification privileges. Migrations run as the `postgres` superuser, so the upgrade script overrides `MCP_DATABASE_URL` for the migrate step:

```bash
docker compose run --rm \
  -e MCP_DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres" \
  mcp migrate
```

`init-users.sh` continues to be operator-run during initial install only. Migrations themselves never need to recreate users.

### New: `deploy/upgrade.sh`

Operator-facing. Ships in the tarball. Pseudocode:

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:-}"
[[ -z "$TARGET" ]] && { echo "Usage: ./upgrade.sh vX.Y.Z [--rollback]"; exit 2; }

if [[ "${2:-}" == "--rollback" ]]; then
  TARGET=$(cat .last-version.bak)
fi

source deploy/.env

# 1. Snapshot
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p ~/backups
docker exec supabase-db pg_dump -U postgres postgres | gzip > ~/backups/pre-upgrade-${TS}.sql.gz

# 2. Stash current version
CURRENT=$(cat .last-version 2>/dev/null || echo "")
echo "$CURRENT" > .last-version.bak

# 3. Auth + pull
echo "$GHCR_PAT" | docker login ghcr.io -u dominikx96 --password-stdin
export MCP_IMAGE="ghcr.io/dominikx96/oc-health-sync-plugin/mcp-server:${TARGET}"
docker compose -f ~/supabase-base/docker/docker-compose.yml -f docker-compose.mcp.yml pull mcp

# 4. Migrate (one-shot, fail-fast)
docker compose ... run --rm \
  -e MCP_DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres" \
  mcp migrate

# 5. Sync edge function code
CID=$(docker create "$MCP_IMAGE")
rm -rf ~/supabase-base/docker/volumes/functions/ingest
docker cp "$CID":/release/functions/ingest ~/supabase-base/docker/volumes/functions/ingest
docker rm "$CID"

# 6. Restart
docker compose ... up -d mcp functions

# 7. Smoke
./smoke.sh

# 8. Commit
echo "$TARGET" > .last-version
echo "Upgraded to $TARGET. Previous: $CURRENT (in .last-version.bak)."
```

Key properties:

- Aborts before *any* state change (snapshot excepted) if pull or migrate fails. Running app stays on the old version.
- Snapshot happens first, while we still know the schema is consistent with the old image.
- `MCP_IMAGE` is pinned per-invocation rather than baked into the compose file, so the same compose file works for all versions. The compose file references `${MCP_IMAGE}` instead of `build:`.

### Modified: `deploy/docker-compose.mcp.yml`

Replace `build:` with `image: ${MCP_IMAGE}`. The `mcp` service no longer has a build context; the image always comes from GHCR.

```yaml
services:
  functions:
    environment:
      INGEST_API_KEY: ${INGEST_API_KEY}
      INGEST_DATABASE_URL: ${INGEST_DATABASE_URL}

  mcp:
    image: ${MCP_IMAGE}
    restart: unless-stopped
    environment:
      MCP_API_KEY: ${MCP_API_KEY}
      MCP_PORT: ${MCP_PORT}
      MCP_DATABASE_URL: ${MCP_DATABASE_URL}
    ports:
      - "127.0.0.1:${MCP_PORT}:${MCP_PORT}"
    depends_on:
      - db
```

### Modified: `deploy/.env.example`

One new entry added:

- `GHCR_PAT` — read-only PAT with `read:packages` scope. Used by `docker login ghcr.io` during install/upgrade. The operator generates this once at https://github.com/settings/tokens.

`MCP_IMAGE` is intentionally *not* in `.env`. It is `export`ed per-invocation by `install.sh` / `upgrade.sh` based on the operator-supplied target version, so the same compose file works for any version without editing.

### New: `deploy/install.sh`

First-run flow. Distinct from `upgrade.sh` — there is no DB to snapshot, no `.last-version` to stash, and the user-creation step (`init-users.sh`) only runs on first install. Pseudocode:

```bash
#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?Usage: ./install.sh vX.Y.Z}"

# 1. Upstream supabase compose
if [[ ! -d ~/supabase-base ]]; then
  git clone --depth 1 https://github.com/supabase/supabase ~/supabase-base
  cp ~/supabase-base/docker/.env.example ~/supabase-base/docker/.env
fi

# 2. Operator-supplied .env must already exist
[[ -f deploy/.env ]] || { echo "Copy .env.example to .env and fill in secrets first."; exit 2; }
cat deploy/.env >> ~/supabase-base/docker/.env

source deploy/.env
echo "$GHCR_PAT" | docker login ghcr.io -u dominikx96 --password-stdin

# 3. Bring stack up on target image
export MCP_IMAGE="ghcr.io/dominikx96/oc-health-sync-plugin/mcp-server:${TARGET}"
docker compose ... pull
docker compose ... up -d db kong functions   # NOT mcp yet — read_user doesn't exist yet

# 4. Wait for db, then create users
until docker exec supabase-db pg_isready -U postgres; do sleep 1; done
./init-users.sh

# 5. Apply migrations as superuser
docker compose ... run --rm \
  -e MCP_DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres" \
  mcp migrate

# 6. Sync edge function code from image to host volume
CID=$(docker create "$MCP_IMAGE")
mkdir -p ~/supabase-base/docker/volumes/functions/ingest
docker cp "$CID":/release/functions/ingest/. ~/supabase-base/docker/volumes/functions/ingest/
docker rm "$CID"

# 7. Now bring up the rest
docker compose ... up -d

# 8. Smoke + commit version
./smoke.sh
echo "$TARGET" > .last-version

echo "Installed $TARGET. Next: configure 'tailscale serve' per deploy/README.md."
```

`install.sh` is run exactly once per VPS. After that, all version transitions go through `upgrade.sh`. Re-running `install.sh` on an already-installed VPS is a misuse — it will likely fail at step 4 because users already exist (mitigated by `init-users.sh` being idempotent, but the snapshot-less flow is still wrong for an upgrade). The script prints a clear error if `.last-version` already exists.

### New: `.github/workflows/release.yml`

Single workflow with two trigger blocks:

```yaml
on:
  push:
    branches: [master]
    tags: ['v*']

permissions:
  contents: write   # for gh release create
  packages: write   # for ghcr push

jobs:
  test-and-publish:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_PASSWORD: postgres
        options: >-
          --health-cmd pg_isready
          --health-interval 10s
        ports: ['5432:5432']
    steps:
      - checkout
      - setup-node 24
      - setup-deno
      - npm ci  (in mcp-server/)
      - npm run typecheck
      - npm test
      - apply migrations to test postgres
      - run SQL schema tests
      - run deno edge-function tests
      - login to ghcr (using GITHUB_TOKEN)
      - docker buildx build --push  (with computed tags — see below)
      - if tag push: assemble tarball, gh release create, upload tarball
```

Tag computation:

```yaml
- if: startsWith(github.ref, 'refs/heads/master')
  TAGS: edge,sha-${{ github.sha }}
- if: startsWith(github.ref, 'refs/tags/v')
  TAGS: ${{ github.ref_name }},latest
```

### New: tarball assembly

In the workflow, after a successful tag-push build:

```bash
mkdir -p oc-health-sync-${{ github.ref_name }}
cp deploy/{install.sh,upgrade.sh,docker-compose.mcp.yml,init-users.sh,.env.example,smoke.sh,README.md} \
   oc-health-sync-${{ github.ref_name }}/
echo "${{ github.ref_name }}" > oc-health-sync-${{ github.ref_name }}/VERSION
tar czf oc-health-sync-${{ github.ref_name }}.tar.gz oc-health-sync-${{ github.ref_name }}/
gh release create ${{ github.ref_name }} oc-health-sync-${{ github.ref_name }}.tar.gz
```

## Data flow

### Release flow (CI side)

```
operator: git tag v0.1.1 && git push --tags
  │
  ▼
GH Actions (release.yml, on tag push)
  │
  ├─ checkout
  ├─ run all tests against ephemeral postgres   ── fail → no publish, exit
  ├─ docker buildx build --push (mcp image, tags: v0.1.1, latest)
  ├─ assemble tarball
  └─ gh release create v0.1.1 + upload tarball
        │
        ▼
GitHub Container Registry  +  GitHub Releases
```

### VPS filesystem layout

State that needs to persist across upgrades lives in a single stable directory, `~/oc-health-sync/`. Each upgrade overwrites the *script* / *compose-file* contents of this directory but leaves the state files alone:

```
~/oc-health-sync/
  upgrade.sh              ← overwritten each upgrade
  install.sh              ← overwritten each upgrade
  docker-compose.mcp.yml  ← overwritten each upgrade
  init-users.sh           ← overwritten each upgrade
  smoke.sh                ← overwritten each upgrade
  .env.example            ← overwritten each upgrade
  VERSION                 ← overwritten each upgrade
  .env                    ← state (never overwritten — operator-edited secrets)
  .last-version           ← state (current version)
  .last-version.bak       ← state (previous version, written by upgrade.sh)

~/backups/                ← state (pg_dump snapshots)
~/supabase-base/          ← upstream supabase compose (operator manages updates manually)
```

`rsync -a --exclude='.env*'` from the extracted tarball into `~/oc-health-sync/` is the safe pattern — preserves `.env` and `.last-version*`, replaces everything else.

### Upgrade flow (VPS side)

The repo is private, so tarball download requires authentication. `gh` CLI is the simplest path: one-time `gh auth login` on the VPS, then every subsequent download is one command. (Alternative: a GitHub PAT in `~/.netrc` — equally fine, less polished.)

```
operator: gh release download v0.1.1 -R dominikx96/oc-health-sync-plugin -p '*.tar.gz'
operator: tar xzf oc-health-sync-v0.1.1.tar.gz
operator: rsync -a --exclude='.env*' --exclude='.last-version*' \
            oc-health-sync-v0.1.1/ ~/oc-health-sync/
operator: cd ~/oc-health-sync && ./upgrade.sh v0.1.1
  │
  ▼
upgrade.sh
  │
  ├─ pg_dump → ~/backups/pre-upgrade-<ts>.sql.gz
  ├─ stash current version → .last-version.bak
  ├─ docker login ghcr.io
  ├─ docker compose pull mcp                    ── fail → abort, app untouched
  ├─ docker compose run --rm mcp migrate        ── fail → abort, app untouched
  ├─ docker cp <new-image>:/release/functions/ingest → host volume
  ├─ docker compose up -d mcp functions
  ├─ ./smoke.sh                                  ── fail → print rollback hint, exit 1
  └─ commit .last-version
```

## Error handling

| Failure | Outcome |
|---|---|
| CI tests fail | Image not pushed. Tag exists on git, but no GHCR tag and no GitHub release. Operator never sees the broken release. |
| `docker pull` fails on VPS | Script aborts before any state change. App still serving old version. |
| `docker compose run --rm mcp migrate` fails | Script aborts before `up -d`. App still serving old version. Snapshot already taken. Operator inspects logs, fixes the migration, re-runs upgrade. |
| `docker cp` fails | Script aborts. App still serving old version (compose `up -d` not yet called). Edge function code on volume may be partially overwritten — operator can re-run upgrade once root cause is fixed (idempotent overwrite). |
| App fails health check after restart | App is on new version, DB on new schema. `./upgrade.sh --rollback` pulls the old image and restarts. DB schema is forward-only, so the previous app version must remain compatible (migration discipline rule, see below). If the operator decides the schema is the issue, restore from `pre-upgrade-<ts>.sql.gz`. |
| GHCR auth fails | Script aborts before pull. Operator regenerates `GHCR_PAT`. |
| Operator runs `./upgrade.sh` with no `.last-version` (first deploy) | `install.sh` is the correct path; `upgrade.sh` detects empty `.last-version` and warns. |

### Migration discipline

To make `--rollback` reliable for the common case, every migration must satisfy:

> The previous image version must continue to function correctly against the new schema.

In practice:

- New columns are nullable, or have defaults.
- New tables don't replace old ones.
- View definitions (`CREATE OR REPLACE VIEW`) keep prior columns or add new ones at the end.
- Destructive changes (column drops, type narrowing) are split across two releases: release N adds the new shape and dual-writes; release N+1 drops the old shape after operator has confirmed the data is migrated.

This is documented in `CONTRIBUTING.md` and reviewed at PR time. Migrations that violate the rule are explicitly flagged in the release notes as "no automatic rollback — restore from snapshot."

## Testing

### CI quality gate (per push & per tag)

- `npm run typecheck` — TypeScript strict.
- `npm test` (vitest) — MCP server unit + integration tests against ephemeral Postgres.
- `psql -f supabase/tests/*.test.sql` — schema and view tests.
- `cd supabase/functions/ingest && deno test --allow-env --allow-net --allow-read` — edge function tests.

All four must pass. Image is only pushed if the job is green.

### Pre-release rehearsal

Before relying on the flow:

1. Push a tag `v0.0.1-rc1` to confirm the workflow produces an image and a tarball.
2. On the VPS, run `./install.sh v0.0.1-rc1` end-to-end.
3. Push a trivial `v0.0.1-rc2` and run `./upgrade.sh v0.0.1-rc2`.
4. Run `./upgrade.sh --rollback` and confirm app returns to `rc1` and `smoke.sh` passes.

Once rehearsed, `v0.1.0` is the first real release.

### Post-upgrade smoke

`upgrade.sh` invokes the existing `smoke.sh` as its final step. `smoke.sh` exercises:

- `POST /functions/v1/ingest` with a valid sample → 200 + `received` count.
- MCP `/mcp` with a valid `Authorization` header → returns the resource list.

Both must succeed before `upgrade.sh` writes `.last-version`.

## Rollout

1. **Implement** — workflow file, `Dockerfile` modifications, top-level `.dockerignore`, `migrate.sh`, `upgrade.sh`, `install.sh`, `.env.example` (`GHCR_PAT`), compose-file change (`build:` → `image: ${MCP_IMAGE}`). PR against `master`.
2. **Rehearse** — push `v0.0.1-rc*` tags as described above.
3. **Cut `v0.1.0`** — first real release. Rewrite `deploy/README.md` to:
   - drop the `git clone` + `docker compose build` flow,
   - add `gh` CLI to prerequisites alongside Docker and Tailscale,
   - document `gh auth login` as a one-time setup step,
   - describe the install vs. upgrade paths.
4. **Document** — short note in `CONTRIBUTING.md` capturing migration discipline (forward-only, backward-compatible-by-one-step) and the release procedure (`git tag vX.Y.Z && git push --tags`, then wait for the green workflow).

## Open questions

None. All design decisions confirmed during brainstorming.
