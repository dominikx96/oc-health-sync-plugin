# oc-health-sync VPS Deploy & Versioning — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current "git clone + docker compose build" deploy flow with a versioned-release pipeline: GitHub Actions builds & publishes a Docker image to private GHCR + a tarball to GitHub Releases on every `v*` tag, and a single `./upgrade.sh vX.Y.Z` command on the VPS pulls the new version, runs migrations as a fail-fast one-shot, and falls back to a fresh `pg_dump` snapshot on rollback.

**Architecture:** One workflow at `.github/workflows/release.yml` triggers on pushes to `master` (publishes `:edge` + `:sha-…` images, no release) and on tags `v*` (publishes `:vX.Y.Z` + `:latest` images plus a release tarball). The MCP image bakes `supabase/migrations/` and `supabase/functions/ingest/` into `/release/`, so the image *is* the release. On the VPS, two operator scripts (`install.sh`, `upgrade.sh`) drive transitions; a stable directory `~/oc-health-sync/` holds operator state across upgrades.

**Tech Stack:** GitHub Actions, Docker buildx, GHCR, `gh` CLI, bash, `shellcheck`, `actionlint`, Postgres 15, existing Node 24 / Deno / vitest / SQL test stacks.

**Reference spec:** `docs/superpowers/specs/2026-05-07-vps-deploy-versioning-design.md`. Read before starting.

**Conventions:**

- Run all commands from the repo root (`oc-health-sync-plugin/`) unless otherwise stated.
- All shell-script edits are followed by a `shellcheck -x <file>` pass; the workflow file is followed by an `actionlint` pass. Treat warnings as failures unless the plan explicitly says otherwise.
- After every commit: run `git status` and verify the working tree is clean before moving on.
- Phases 1–5 happen on the `feature/supabase-mcp-rewrite` branch. Phases 6–7 happen against `master` (require merge first).
- "Test" for shell scripts here means static analysis + a targeted manual exercise (build, dry-run, etc.); we are not setting up Bats. The full integration test is the rehearsal in Phase 6.

---

## Phase 1 — Image artifacts (Dockerfile, .dockerignore, migrate)

The MCP image becomes the single source of truth for a release: it carries the runtime *and* migrations *and* edge function source. To `COPY supabase/...` we must move the build context from `mcp-server/` to the repo root.

### Task 1.1: Replace the Dockerfile build context

**Files:**
- Modify: `mcp-server/Dockerfile`

The new file is `mcp-server/Dockerfile` (still at the same path, but its build context becomes the repo root, so paths now begin with `mcp-server/`).

- [ ] **Step 1: Rewrite the Dockerfile**

Replace the entire contents of `mcp-server/Dockerfile` with:

```dockerfile
# Build context is the repo root (so we can COPY supabase/... into the image).
# Build with: docker build -f mcp-server/Dockerfile -t <tag> .

FROM node:24-alpine AS build
WORKDIR /app
COPY mcp-server/package.json mcp-server/package-lock.json* ./
RUN npm ci
COPY mcp-server/ .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# psql is needed by the `migrate` entrypoint. bash makes the migrate script portable.
RUN apk add --no-cache postgresql-client bash

COPY mcp-server/package.json mcp-server/package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist                     ./dist

# Release payload baked into the image.
COPY supabase/migrations                        /release/migrations
COPY supabase/functions/ingest                  /release/functions/ingest
COPY mcp-server/scripts/migrate.sh              /usr/local/bin/migrate
RUN chmod +x /usr/local/bin/migrate

EXPOSE 3737
CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Confirm — do not build yet**

The migrate script doesn't exist yet (Task 1.3). Don't try to build the image until Task 1.4. Just save the file.

- [ ] **Step 3: Commit**

```bash
git add mcp-server/Dockerfile
git commit -m "chore(mcp): rebase Dockerfile on repo-root build context"
```

---

### Task 1.2: Replace `mcp-server/.dockerignore` with a top-level one

**Files:**
- Delete: `mcp-server/.dockerignore`
- Create: `.dockerignore` (repo root)

The build context is now repo root, so we need a repo-root ignore that keeps the build context tight. The old `mcp-server/.dockerignore` is no longer reachable.

- [ ] **Step 1: Delete the old `.dockerignore`**

```bash
git rm mcp-server/.dockerignore
```

- [ ] **Step 2: Create the new top-level `.dockerignore`**

Create `.dockerignore` at the repo root with these contents:

```
# Repo-root .dockerignore for the mcp-server image build.
# Build context is the repo root so we can COPY supabase/... into the image.
# This file aggressively trims the context to what the Dockerfile actually needs:
#   - mcp-server/  (sources, package files, scripts/)
#   - supabase/migrations/
#   - supabase/functions/ingest/

# Top-level noise
.git
.github
.gitignore
.claude
.vscode
README.md
docs
agent_example
skill_example
_legacy
node_modules

# Per-subproject noise that should not be in the build context
mcp-server/node_modules
mcp-server/dist
mcp-server/.env
mcp-server/.dockerignore
mcp-server/__tests__
mcp-server/*.log

# supabase: keep only migrations/ and functions/ingest/
supabase/.branches
supabase/.temp
supabase/config.toml
supabase/seed.sql
supabase/snippets
supabase/tests
supabase/functions/_shared
supabase/functions/*/node_modules

# everything in deploy/ is operator-side — never inside the image
deploy
```

- [ ] **Step 3: Commit**

```bash
git add .dockerignore mcp-server/.dockerignore
git commit -m "chore(docker): move .dockerignore to repo root for new build context"
```

---

### Task 1.3: Add `mcp-server/scripts/migrate.sh`

**Files:**
- Create: `mcp-server/scripts/migrate.sh`

This script is the `migrate` entrypoint of the image. It runs all baked-in migrations as `MCP_DATABASE_URL` (which the upgrade flow overrides to a superuser DSN at runtime).

- [ ] **Step 1: Create the script**

```bash
mkdir -p mcp-server/scripts
```

Create `mcp-server/scripts/migrate.sh` with these contents:

```bash
#!/usr/bin/env bash
# migrate — apply baked-in SQL migrations in lexical order against $MCP_DATABASE_URL.
#
# This script lives at /usr/local/bin/migrate inside the image. The migrations live at
# /release/migrations/. The caller (upgrade.sh / install.sh) is expected to pass a
# *superuser* DSN via MCP_DATABASE_URL, since the runtime read_user lacks DDL rights.
#
# Migrations MUST be idempotent (CREATE … IF NOT EXISTS / CREATE OR REPLACE) — see
# CONTRIBUTING.md for the rules.

set -euo pipefail

: "${MCP_DATABASE_URL:?MCP_DATABASE_URL must be set (use a superuser DSN)}"

MIGRATIONS_DIR="/release/migrations"
[[ -d "$MIGRATIONS_DIR" ]] || { echo "FATAL: $MIGRATIONS_DIR not found in image" >&2; exit 2; }

shopt -s nullglob
files=("$MIGRATIONS_DIR"/*.sql)
shopt -u nullglob

if (( ${#files[@]} == 0 )); then
  echo "No migrations found in $MIGRATIONS_DIR. Nothing to do."
  exit 0
fi

for f in "${files[@]}"; do
  echo "→ Applying $(basename "$f")"
  psql "$MCP_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"
done

echo "✓ All ${#files[@]} migration(s) applied."
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x mcp-server/scripts/migrate.sh
```

- [ ] **Step 3: Lint with shellcheck**

```bash
shellcheck -x mcp-server/scripts/migrate.sh
```

Expected: no output (clean pass). If `shellcheck` is not installed, install it first (`brew install shellcheck`).

- [ ] **Step 4: Commit**

```bash
git add mcp-server/scripts/migrate.sh
git commit -m "feat(mcp): add migrate entrypoint script"
```

---

### Task 1.4: Build the image and verify the bake

**Files:**
- (no source changes; verification only)

- [ ] **Step 1: Build the image from the repo root**

```bash
docker build -f mcp-server/Dockerfile -t oc-health-sync-mcp:dev .
```

Expected: build succeeds. Final stage shows `psql` install, `npm ci --omit=dev`, and the three release `COPY` lines complete.

- [ ] **Step 2: Inspect the bake**

```bash
docker run --rm --entrypoint sh oc-health-sync-mcp:dev -c \
  'ls /release/migrations && echo --- && ls /release/functions/ingest && echo --- && ls -l /usr/local/bin/migrate'
```

Expected output (paths, exact filenames may differ slightly):

```
20260507000000_init_tables.sql
20260507000100_roles.sql
20260507000200_metrics_views.sql
20260507000300_data_completeness.sql
20260507000400_detect_anomalies.sql
---
README.md
auth.test.ts
auth.ts
db.ts
deno.json
deno.lock
handler.test.ts
handler.ts
index.test.ts
index.ts
schema.test.ts
schema.ts
---
-rwxr-xr-x ... /usr/local/bin/migrate
```

If the migrations or functions list is missing entries, the `.dockerignore` is too aggressive — adjust it.

- [ ] **Step 3: Verify migrate runs against a fresh local Postgres**

Boot Postgres and the migrate-runner on a shared docker network (portable across macOS/Linux — avoids `host.docker.internal` quirks):

```bash
docker network create migrate-test-net
docker run --rm -d --name pg-migrate-check --network migrate-test-net \
  -e POSTGRES_PASSWORD=postgres postgres:15
# Wait for Postgres to be ready
until docker exec pg-migrate-check pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker run --rm --network migrate-test-net \
  -e MCP_DATABASE_URL="postgresql://postgres:postgres@pg-migrate-check:5432/postgres" \
  --entrypoint /usr/local/bin/migrate \
  oc-health-sync-mcp:dev
```

Expected: every migration file is logged as `→ Applying …` and the final line reads `✓ All 5 migration(s) applied.` Exit code 0.

- [ ] **Step 4: Tear down**

```bash
docker stop pg-migrate-check
docker network rm migrate-test-net
docker rmi oc-health-sync-mcp:dev
```

- [ ] **Step 5: Commit (no source change — this task is verification only)**

If you needed to adjust `.dockerignore` or `mcp-server/Dockerfile` to make the build pass, amend those changes now. Otherwise nothing to commit — proceed to Phase 2.

---

## Phase 2 — Compose & env

### Task 2.1: Update `deploy/docker-compose.mcp.yml` to pull from GHCR

**Files:**
- Modify: `deploy/docker-compose.mcp.yml`

- [ ] **Step 1: Replace the file contents**

Overwrite `deploy/docker-compose.mcp.yml` with:

```yaml
# Overlay: combine with supabase/docker/docker-compose.yml from the upstream repo:
#   docker compose -f /path/to/supabase/docker/docker-compose.yml -f docker-compose.mcp.yml up -d
#
# This file intentionally does NOT redefine db / kong / functions / studio — those
# come from the upstream compose. We only:
#   - inject INGEST_API_KEY and INGEST_DATABASE_URL into the functions container
#   - add our mcp-server service on the same network
#
# MCP_IMAGE is exported per-invocation by deploy/install.sh and deploy/upgrade.sh,
# e.g. MCP_IMAGE=ghcr.io/dominikx96/oc-health-sync-plugin/mcp-server:v0.1.0.

name: oc-health-sync

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

- [ ] **Step 2: Validate compose syntax**

`docker compose config` requires both files to merge cleanly. Without the upstream file we can only do a partial check, but it catches typos:

```bash
MCP_IMAGE=ghcr.io/example/example:v0 \
INGEST_API_KEY=x INGEST_DATABASE_URL=x \
MCP_API_KEY=x MCP_PORT=3737 MCP_DATABASE_URL=x \
docker compose -f deploy/docker-compose.mcp.yml config >/dev/null
```

Expected: exits 0 (the unknown-`functions`-and-`db` warnings are normal — those services are defined in the upstream compose).

- [ ] **Step 3: Commit**

```bash
git add deploy/docker-compose.mcp.yml
git commit -m "chore(deploy): pull mcp image from GHCR instead of building locally"
```

---

### Task 2.2: Add `GHCR_PAT` to `deploy/.env.example`

**Files:**
- Modify: `deploy/.env.example`

- [ ] **Step 1: Append the new entry**

Open `deploy/.env.example` and append at the bottom (after `READ_USER_PASSWORD`):

```
# GitHub Container Registry — read-only PAT used by install.sh / upgrade.sh.
# Generate at https://github.com/settings/tokens with scope: read:packages.
# Tied to your GitHub user (operator account).
GHCR_PAT=changeme-ghcr-readonly-pat
```

The exact final file should look like (showing only the appended block):

```
# Per-environment login users for the two roles. Created by deploy/init-users.sh,
# which is run once after migrations.
INGEST_USER_PASSWORD=changeme-ingest-pw
READ_USER_PASSWORD=changeme-read-pw

# GitHub Container Registry — read-only PAT used by install.sh / upgrade.sh.
# Generate at https://github.com/settings/tokens with scope: read:packages.
# Tied to your GitHub user (operator account).
GHCR_PAT=changeme-ghcr-readonly-pat
```

- [ ] **Step 2: Commit**

```bash
git add deploy/.env.example
git commit -m "chore(deploy): add GHCR_PAT to .env.example"
```

---

## Phase 3 — Operator scripts

The two scripts below assume:

- `~/supabase-base/docker/docker-compose.yml` exists (cloned from `github.com/supabase/supabase`).
- The current working directory when the script runs is `~/oc-health-sync/` (the stable state directory), and `deploy/.env` has been merged into `~/supabase-base/docker/.env` already (by `install.sh` on first run).
- Because the upstream compose runs with `--project-directory ~/supabase-base/docker`, the MCP image is referenced via the `MCP_IMAGE` env var that the script `export`s.

A small helper, `dc()`, encapsulates the long compose invocation.

### Task 3.1: Add `deploy/upgrade.sh`

**Files:**
- Create: `deploy/upgrade.sh`

- [ ] **Step 1: Write the script**

Create `deploy/upgrade.sh` with these contents:

```bash
#!/usr/bin/env bash
# upgrade.sh — pull a new MCP image, run migrations as a one-shot, sync edge
# function code, restart, smoke-test, commit. Pre-upgrade pg_dump always runs.
#
# Usage:
#   ./upgrade.sh vX.Y.Z              upgrade to that version
#   ./upgrade.sh --rollback           re-pull the version stashed in .last-version.bak
#
# Refuses to run if .last-version is missing (use install.sh for first-time setup).

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OWNER="dominikx96"
REPO="oc-health-sync-plugin"
PACKAGE="mcp-server"
IMAGE_BASE="ghcr.io/${OWNER}/${REPO}/${PACKAGE}"
SUPABASE_DIR="${HOME}/supabase-base/docker"
FUNCTIONS_VOLUME="${SUPABASE_DIR}/volumes/functions/ingest"
BACKUP_DIR="${HOME}/backups"

usage() {
  cat <<EOF >&2
Usage:
  ./upgrade.sh vX.Y.Z       upgrade to that version
  ./upgrade.sh --rollback    revert to the version recorded in .last-version.bak
EOF
  exit 2
}

[[ $# -ge 1 ]] || usage

if [[ "$1" == "--rollback" ]]; then
  [[ -s .last-version.bak ]] || { echo "FATAL: .last-version.bak is missing or empty — nothing to roll back to." >&2; exit 2; }
  TARGET="$(cat .last-version.bak)"
  echo "→ Rolling back to ${TARGET}"
else
  TARGET="$1"
fi

[[ -f .last-version ]] || {
  echo "FATAL: .last-version is missing. Use ./install.sh first." >&2
  exit 2
}

[[ -f .env ]] || { echo "FATAL: .env not found in $(pwd)" >&2; exit 2; }
# shellcheck disable=SC1091
set -a; source ./.env; set +a

: "${POSTGRES_PASSWORD:?must be in .env}"
: "${GHCR_PAT:?must be in .env}"

dc() {
  docker compose \
    --project-directory "${SUPABASE_DIR}" \
    -f "${SUPABASE_DIR}/docker-compose.yml" \
    -f "${SCRIPT_DIR}/docker-compose.mcp.yml" \
    "$@"
}

# 1. Snapshot — always, before any state change.
mkdir -p "${BACKUP_DIR}"
TS="$(date +%Y%m%d-%H%M%S)"
SNAP="${BACKUP_DIR}/pre-upgrade-${TS}.sql.gz"
echo "→ Snapshotting DB to ${SNAP}"
docker exec supabase-db pg_dump -U postgres postgres | gzip > "${SNAP}"

# 2. Stash current version.
CURRENT="$(cat .last-version)"
echo "${CURRENT}" > .last-version.bak
echo "→ Previous version stashed in .last-version.bak: ${CURRENT}"

# 3. Auth + pull.
echo "→ Authenticating to GHCR"
echo "${GHCR_PAT}" | docker login ghcr.io -u "${OWNER}" --password-stdin

export MCP_IMAGE="${IMAGE_BASE}:${TARGET}"
echo "→ Pulling ${MCP_IMAGE}"
dc pull mcp

# 4. Migrate — fail-fast, before any restart.
echo "→ Running migrations"
dc run --rm \
  -e MCP_DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres" \
  --entrypoint /usr/local/bin/migrate \
  mcp

# 5. Sync edge function code from image to host volume.
echo "→ Syncing edge function code"
CID="$(docker create "${MCP_IMAGE}")"
trap 'docker rm "${CID}" >/dev/null 2>&1 || true' EXIT
mkdir -p "${FUNCTIONS_VOLUME}"
rm -rf "${FUNCTIONS_VOLUME:?}"/*
docker cp "${CID}":/release/functions/ingest/. "${FUNCTIONS_VOLUME}/"
docker rm "${CID}" >/dev/null
trap - EXIT

# 6. Restart.
echo "→ Restarting mcp + functions"
dc up -d mcp functions

# 7. Smoke.
echo "→ Smoke test"
./smoke.sh

# 8. Commit version pointer.
echo "${TARGET}" > .last-version

echo "✓ Upgraded to ${TARGET}. Previous: ${CURRENT} (in .last-version.bak)."
echo "  Snapshot: ${SNAP}"
```

- [ ] **Step 2: Make executable**

```bash
chmod +x deploy/upgrade.sh
```

- [ ] **Step 3: Lint**

```bash
shellcheck -x deploy/upgrade.sh
```

Expected: no output. (The `# shellcheck disable=SC1091` line above suppresses the only expected warning, about `source ./.env` not being statically resolvable.)

- [ ] **Step 4: Commit**

```bash
git add deploy/upgrade.sh
git commit -m "feat(deploy): add upgrade.sh"
```

---

### Task 3.2: Add `deploy/install.sh`

**Files:**
- Create: `deploy/install.sh`

- [ ] **Step 1: Write the script**

Create `deploy/install.sh` with these contents:

```bash
#!/usr/bin/env bash
# install.sh — first-time setup. Distinct from upgrade.sh because there's no DB
# to snapshot, no .last-version to stash, and init-users.sh has to run before mcp
# can connect with read_user.
#
# Usage:
#   ./install.sh vX.Y.Z

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OWNER="dominikx96"
REPO="oc-health-sync-plugin"
PACKAGE="mcp-server"
IMAGE_BASE="ghcr.io/${OWNER}/${REPO}/${PACKAGE}"
SUPABASE_DIR="${HOME}/supabase-base/docker"
FUNCTIONS_VOLUME="${SUPABASE_DIR}/volumes/functions/ingest"

[[ $# -eq 1 ]] || { echo "Usage: ./install.sh vX.Y.Z" >&2; exit 2; }
TARGET="$1"

if [[ -f .last-version ]]; then
  echo "FATAL: .last-version exists — this VPS is already installed." >&2
  echo "       Use ./upgrade.sh ${TARGET} instead." >&2
  exit 2
fi

[[ -f .env ]] || {
  echo "FATAL: .env not found in $(pwd)." >&2
  echo "       Copy .env.example to .env and fill in the secrets first." >&2
  exit 2
}

# shellcheck disable=SC1091
set -a; source ./.env; set +a

: "${POSTGRES_PASSWORD:?must be in .env}"
: "${GHCR_PAT:?must be in .env}"

# 1. Upstream supabase compose.
if [[ ! -d "${HOME}/supabase-base" ]]; then
  echo "→ Cloning upstream supabase compose"
  git clone --depth 1 https://github.com/supabase/supabase "${HOME}/supabase-base"
  cp "${SUPABASE_DIR}/.env.example" "${SUPABASE_DIR}/.env"
fi

# Append our env vars to the upstream .env (idempotent — never duplicate the marker).
MARKER="# --- oc-health-sync overlay ---"
if ! grep -qF "${MARKER}" "${SUPABASE_DIR}/.env"; then
  echo "→ Merging deploy/.env into ${SUPABASE_DIR}/.env"
  {
    printf '\n%s\n' "${MARKER}"
    cat .env
  } >> "${SUPABASE_DIR}/.env"
fi

dc() {
  docker compose \
    --project-directory "${SUPABASE_DIR}" \
    -f "${SUPABASE_DIR}/docker-compose.yml" \
    -f "${SCRIPT_DIR}/docker-compose.mcp.yml" \
    "$@"
}

# 2. Auth + pull.
echo "→ Authenticating to GHCR"
echo "${GHCR_PAT}" | docker login ghcr.io -u "${OWNER}" --password-stdin

export MCP_IMAGE="${IMAGE_BASE}:${TARGET}"
echo "→ Pulling ${MCP_IMAGE}"
dc pull

# 3. Bring up everything except mcp (read_user doesn't exist yet).
echo "→ Starting db, kong, functions"
dc up -d db kong functions

# 4. Wait for db.
echo "→ Waiting for Postgres"
for _ in $(seq 1 60); do
  if docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1 \
  || { echo "FATAL: Postgres did not become ready in 60s" >&2; exit 1; }

# 5. Apply migrations as superuser (must run before init-users.sh — roles
#    health_ingest_role / health_read_role are CREATEd by 20260507000100_roles.sql).
echo "→ Running migrations"
dc run --rm \
  -e MCP_DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres" \
  --entrypoint /usr/local/bin/migrate \
  mcp

# 6. Create login users (ingest_user, read_user).
echo "→ Creating login users"
./init-users.sh

# 7. Sync edge function code from image to host volume.
echo "→ Syncing edge function code"
CID="$(docker create "${MCP_IMAGE}")"
trap 'docker rm "${CID}" >/dev/null 2>&1 || true' EXIT
mkdir -p "${FUNCTIONS_VOLUME}"
docker cp "${CID}":/release/functions/ingest/. "${FUNCTIONS_VOLUME}/"
docker rm "${CID}" >/dev/null
trap - EXIT

# 8. Bring up the rest (mcp can now connect).
echo "→ Starting mcp"
dc up -d

# 9. Smoke + commit.
echo "→ Smoke test"
./smoke.sh

echo "${TARGET}" > .last-version

cat <<EOF

✓ Installed ${TARGET}.

Next:
  1. Configure 'tailscale serve' to expose the services on your tailnet:
       sudo tailscale serve --bg --tcp 8000 8000
       sudo tailscale serve --bg --tcp ${MCP_PORT:-3737} ${MCP_PORT:-3737}
  2. Configure the iOS app and your MCP client per deploy/README.md.
EOF
```

- [ ] **Step 2: Make executable**

```bash
chmod +x deploy/install.sh
```

- [ ] **Step 3: Lint**

```bash
shellcheck -x deploy/install.sh
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add deploy/install.sh
git commit -m "feat(deploy): add install.sh"
```

---

## Phase 4 — CI workflow

### Task 4.1: Add `.github/workflows/release.yml`

**Files:**
- Create: `.github/workflows/release.yml`

This workflow runs the full test suite, then publishes the image. On tag pushes it also assembles & uploads a release tarball.

- [ ] **Step 1: Create directories**

```bash
mkdir -p .github/workflows
```

- [ ] **Step 2: Write the workflow**

Create `.github/workflows/release.yml` with these contents:

```yaml
name: release

on:
  push:
    branches:
      - master
    tags:
      - 'v*'

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
        ports:
          - 5432:5432
        options: >-
          --health-cmd pg_isready
          --health-interval 5s
          --health-timeout 5s
          --health-retries 10

    env:
      PGURL_SUPER: postgresql://postgres:postgres@127.0.0.1:5432/postgres

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node 24
        uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: 'npm'
          cache-dependency-path: mcp-server/package-lock.json

      - name: Set up Deno
        uses: denoland/setup-deno@v2
        with:
          deno-version: v2.x

      - name: Install psql client
        run: sudo apt-get update && sudo apt-get install -y postgresql-client

      - name: Install MCP server deps
        working-directory: mcp-server
        run: npm ci

      - name: Typecheck MCP server
        working-directory: mcp-server
        run: npm run typecheck

      - name: Apply migrations to test postgres
        run: |
          for f in supabase/migrations/*.sql; do
            echo "→ $f"
            psql "$PGURL_SUPER" -v ON_ERROR_STOP=1 -f "$f"
          done

      - name: Apply seed.sql (creates test users ingest_user / read_user)
        run: psql "$PGURL_SUPER" -v ON_ERROR_STOP=1 -f supabase/seed.sql

      - name: Run SQL schema tests
        run: |
          for t in supabase/tests/*.test.sql; do
            echo "→ $t"
            psql "$PGURL_SUPER" -v ON_ERROR_STOP=1 -f "$t"
          done

      - name: Run vitest (mcp-server)
        working-directory: mcp-server
        env:
          MCP_DATABASE_URL: postgresql://read_user:read_pw@127.0.0.1:5432/postgres
        run: npm test

      - name: Run deno tests (ingest edge function)
        working-directory: supabase/functions/ingest
        env:
          INGEST_DATABASE_URL: postgresql://ingest_user:ingest_pw@127.0.0.1:5432/postgres
          INGEST_API_KEY: ci-ingest-key
        run: deno test --allow-env --allow-net --allow-read

      - name: Set up Docker buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Compute image tags
        id: tags
        run: |
          IMAGE="ghcr.io/${{ github.repository_owner }}/oc-health-sync-plugin/mcp-server"
          if [[ "${GITHUB_REF}" == refs/tags/v* ]]; then
            VERSION="${GITHUB_REF#refs/tags/}"
            echo "version=${VERSION}" >> "$GITHUB_OUTPUT"
            echo "tags=${IMAGE}:${VERSION},${IMAGE}:latest" >> "$GITHUB_OUTPUT"
            echo "is_release=true" >> "$GITHUB_OUTPUT"
          else
            SHORT="${GITHUB_SHA:0:7}"
            echo "version=" >> "$GITHUB_OUTPUT"
            echo "tags=${IMAGE}:edge,${IMAGE}:sha-${SHORT}" >> "$GITHUB_OUTPUT"
            echo "is_release=false" >> "$GITHUB_OUTPUT"
          fi

      - name: Build & push image
        uses: docker/build-push-action@v6
        with:
          context: .
          file: mcp-server/Dockerfile
          push: true
          tags: ${{ steps.tags.outputs.tags }}

      - name: Assemble release tarball
        if: steps.tags.outputs.is_release == 'true'
        run: |
          VER="${{ steps.tags.outputs.version }}"
          DIR="oc-health-sync-${VER}"
          mkdir -p "${DIR}"
          cp deploy/install.sh \
             deploy/upgrade.sh \
             deploy/docker-compose.mcp.yml \
             deploy/init-users.sh \
             deploy/.env.example \
             deploy/smoke.sh \
             deploy/README.md \
             "${DIR}/"
          echo "${VER}" > "${DIR}/VERSION"
          tar czf "${DIR}.tar.gz" "${DIR}"
          ls -l "${DIR}.tar.gz"

      - name: Create GitHub release with tarball
        if: steps.tags.outputs.is_release == 'true'
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          VER="${{ steps.tags.outputs.version }}"
          gh release create "${VER}" "oc-health-sync-${VER}.tar.gz" \
            --title "${VER}" \
            --notes "Automated release. See spec at docs/superpowers/specs/2026-05-07-vps-deploy-versioning-design.md."
```

- [ ] **Step 3: Lint with actionlint**

```bash
# If actionlint is not installed:
#   brew install actionlint        (macOS)
#   go install github.com/rhysd/actionlint/cmd/actionlint@latest
actionlint .github/workflows/release.yml
```

Expected: no output (clean pass).

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci: add release workflow (test gate + GHCR + tarball)"
```

---

### Task 4.2: Wet test the workflow on the feature branch

The workflow's `branches:` list does not yet include `feature/supabase-mcp-rewrite`, so a normal feature-branch push does *not* trigger a run. We temporarily add the branch to validate the test gate end-to-end before merging.

- [ ] **Step 1: Temporarily widen the trigger**

Edit `.github/workflows/release.yml`. In the `on.push.branches` list, add the feature branch:

```yaml
on:
  push:
    branches:
      - master
      - feature/supabase-mcp-rewrite
    tags:
      - 'v*'
```

Also, since we don't want the test run to publish a real image while we're still verifying, gate the publish steps on `github.ref` being `master` *or* a tag:

```yaml
      - name: Build & push image
        if: github.ref == 'refs/heads/master' || startsWith(github.ref, 'refs/tags/v')
        uses: docker/build-push-action@v6
        ...
```

Apply the same `if:` to the **GHCR login** step and the **Compute image tags** step. (Easier alternative: add `if: github.ref != 'refs/heads/feature/supabase-mcp-rewrite'` to each. Either works.)

The test-suite steps remain unconditional, so they run on every push.

- [ ] **Step 2: Push and watch**

```bash
git add .github/workflows/release.yml
git commit -m "ci: temporarily run workflow on feature branch (will revert)"
git push
gh run watch --exit-status
```

Expected: `gh run watch` reports a successful run. The publish steps are skipped (via the `if:` you added). All test steps must pass green.

- [ ] **Step 3: Inspect the run**

```bash
gh run list --workflow release.yml --limit 1
gh run view --log
```

Confirm:

- Migrations applied successfully against the postgres service container.
- All four test phases (typecheck, vitest, SQL schema tests, deno tests) ran and passed.
- The image build/push step was *skipped*, not failed.

- [ ] **Step 4: Revert the temporary trigger**

Edit `.github/workflows/release.yml` again. Restore the original trigger and remove the publish-step `if:` guards you added:

```yaml
on:
  push:
    branches:
      - master
    tags:
      - 'v*'
```

Each publish step goes back to its original form (no extra `if:`).

- [ ] **Step 5: Commit the revert**

```bash
git add .github/workflows/release.yml
git commit -m "ci: revert temporary feature-branch trigger"
```

---

## Phase 5 — Documentation

### Task 5.1: Rewrite `deploy/README.md` for the new flow

**Files:**
- Modify: `deploy/README.md`

The old README documents the `git clone + docker compose build` flow. Replace it with the install/upgrade flow. The README ships inside the release tarball, so it has to read coherently as a standalone doc inside `~/oc-health-sync/`.

- [ ] **Step 1: Replace the contents**

Overwrite `deploy/README.md` with:

````markdown
# Deploying oc-health-sync to a VPS

This guide walks through deploying oc-health-sync on a Linux VPS. Releases come from a CI pipeline as **(a)** a private Docker image on GHCR and **(b)** this very tarball, attached to a GitHub release. The VPS pulls both, runs `install.sh` once, and then runs `upgrade.sh` for every subsequent version transition.

The stack is Tailscale-isolated (no public inbound ports) and layers our compose overlay on top of the upstream [supabase/supabase](https://github.com/supabase/supabase) self-host docker setup.

## Prerequisites

- A Linux VPS with a public IP (Ubuntu 22.04+ recommended).
- **Docker** — `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER` (log out and back in after).
- **Tailscale** — `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`.
- **`postgresql-client`** — `init-users.sh` runs `psql` from the host: `sudo apt-get install -y postgresql-client`.
- **`rsync`** — used to overlay each new tarball onto `~/oc-health-sync/`: `sudo apt-get install -y rsync`.
- **`gh` CLI** — needed to download the private release tarball:
  ```
  type -p curl >/dev/null || sudo apt-get install -y curl
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
  sudo apt-get update && sudo apt-get install -y gh
  gh auth login            # one-time browser flow
  ```
- A **GitHub PAT** with `read:packages` scope, to write into `deploy/.env` as `GHCR_PAT`. Generate at https://github.com/settings/tokens.

## First-time install

### Step 1 — Download and extract the release tarball

```bash
TARGET=v0.1.0   # whichever release you want
gh release download "$TARGET" \
  -R dominikx96/oc-health-sync-plugin \
  -p '*.tar.gz'
tar xzf "oc-health-sync-${TARGET}.tar.gz"
mkdir -p ~/oc-health-sync
rsync -a --exclude='.env*' --exclude='.last-version*' \
  "oc-health-sync-${TARGET}/" ~/oc-health-sync/
cd ~/oc-health-sync
```

The `rsync` line is the same on first install and every upgrade: it never overwrites operator-managed state (`.env`, `.last-version*`).

### Step 2 — Configure secrets

```bash
cp .env.example .env
```

Open `.env` and replace every `changeme-*` placeholder. See the comments inline; in particular:

| Variable | Notes |
|---|---|
| `POSTGRES_PASSWORD` | Strong random password for the `postgres` superuser. |
| `JWT_SECRET` | At least 32 characters. |
| `ANON_KEY` / `SERVICE_ROLE_KEY` | JWTs signed with `JWT_SECRET` — see the [Supabase JWT generator](https://supabase.com/docs/guides/self-hosting/docker#generate-api-keys). |
| `INGEST_API_KEY` | Bearer token the iOS app sends. |
| `MCP_API_KEY` | Bearer token the MCP client sends. |
| `INGEST_USER_PASSWORD` / `READ_USER_PASSWORD` | Must match the password in the corresponding DB URL. |
| `GHCR_PAT` | Read-only GitHub PAT with `read:packages`. |

### Step 3 — Confirm `.env` then run `install.sh`

```bash
./install.sh "$TARGET"
```

This script:

1. Clones upstream supabase compose into `~/supabase-base/` (idempotent).
2. Merges `.env` into `~/supabase-base/docker/.env`.
3. `docker login` to GHCR with `GHCR_PAT`.
4. Pulls the MCP image at `$TARGET`.
5. Brings up `db`, `kong`, `functions`.
6. Waits for Postgres.
7. Runs migrations as the `postgres` superuser.
8. Runs `init-users.sh` to create `ingest_user` and `read_user`.
9. Copies the edge function source from the image into the upstream `functions/ingest/` volume.
10. Brings up `mcp`.
11. Runs `smoke.sh`.
12. Records `$TARGET` in `.last-version`.

A passing run prints `✓ Installed $TARGET.` and instructions for the next step.

### Step 4 — Expose to your tailnet

```bash
sudo tailscale serve --bg --tcp 8000 8000
sudo tailscale serve --bg --tcp 3737 3737     # or whatever MCP_PORT you set
tailscale serve status
```

> **Security:** Do **not** use `tailscale funnel`. Funnel exposes services to the public internet; `serve` restricts access to your tailnet only.

### Step 5 — Configure the iOS app and MCP client

**iOS app:**
- Server URL: `http://<tailscale-ip>:8000/functions/v1/ingest`
- API key: `INGEST_API_KEY` from `.env`

**MCP client (e.g. `~/Library/Application Support/Claude/claude_desktop_config.json`):**

```json
{
  "mcpServers": {
    "oc-health-sync": {
      "url": "http://<tailscale-ip>:3737/mcp",
      "headers": { "Authorization": "Bearer <your-MCP_API_KEY>" }
    }
  }
}
```

Find your VPS's tailnet IP with `tailscale ip -4`.

## Upgrading to a new version

```bash
TARGET=v0.1.1
gh release download "$TARGET" \
  -R dominikx96/oc-health-sync-plugin \
  -p '*.tar.gz'
tar xzf "oc-health-sync-${TARGET}.tar.gz"
rsync -a --exclude='.env*' --exclude='.last-version*' \
  "oc-health-sync-${TARGET}/" ~/oc-health-sync/
cd ~/oc-health-sync
./upgrade.sh "$TARGET"
```

`upgrade.sh`:

1. Snapshots the DB to `~/backups/pre-upgrade-<timestamp>.sql.gz`.
2. Stashes the current `.last-version` in `.last-version.bak`.
3. `docker login` to GHCR.
4. Pulls the MCP image at `$TARGET`.
5. Runs migrations as a one-shot — fails fast if any migration breaks; the running app is untouched.
6. Copies new edge function source into the host volume.
7. Restarts `mcp` and `functions`.
8. Runs `smoke.sh`.
9. Writes `$TARGET` into `.last-version`.

If anything fails after step 5, the previous version is still recorded in `.last-version.bak`.

## Rollback

```bash
cd ~/oc-health-sync
./upgrade.sh --rollback
```

Re-pulls the version recorded in `.last-version.bak`, runs migrations (forward-only, so this is a no-op for the rollback case as long as migration discipline is followed — see `CONTRIBUTING.md`), and restarts.

If the schema is incompatible with the old image (i.e. migration discipline was violated), restore from the snapshot:

```bash
gunzip -c ~/backups/pre-upgrade-<timestamp>.sql.gz \
  | docker exec -i supabase-db psql -U postgres postgres
```

## Backup

The Postgres data lives in the upstream Supabase compose's named volumes. Schedule a daily snapshot:

```bash
# crontab -e
0 2 * * * docker run --rm -v supabase_db-data:/data -v $HOME/backups:/backup alpine tar czf /backup/db-backup-$(date +\%F).tar.gz /data
```

Store backups off-VPS (e.g., `rclone copy ~/backups/ remote:oc-health-sync-backups/`).

## File layout on the VPS

```
~/oc-health-sync/
  upgrade.sh, install.sh, ...       ← overwritten on every upgrade (rsync from tarball)
  .env                              ← state — operator-edited secrets
  .last-version, .last-version.bak  ← state — managed by install/upgrade scripts

~/supabase-base/                    ← upstream supabase clone
~/backups/                          ← pg_dump snapshots
```
````

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): rewrite for versioned-release flow"
```

---

### Task 5.2: Add `CONTRIBUTING.md`

**Files:**
- Create: `CONTRIBUTING.md`

Captures migration discipline (so rollback stays reliable) and the release procedure (so the next release isn't accidental).

- [ ] **Step 1: Create the file**

Create `CONTRIBUTING.md` at the repo root with these contents:

````markdown
# Contributing to oc-health-sync

## Cutting a release

A release is a single git tag plus the artifacts that the `release.yml` workflow produces from it (image on GHCR, tarball on GitHub Releases).

```bash
# All on master, after a green CI build of the merge commit:
git checkout master && git pull
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

See the top-level `README.md` for the local-dev loop with `supabase start`. The CI test set mirrors the local one — if `npm test`, `psql -f supabase/tests/*.test.sql`, and `deno test` all pass locally, CI will pass.

## Branching

- `master` — protected; every commit has gone through CI.
- `feature/*` — work branches. CI does **not** run on these by default. To wet-test the workflow on a feature branch, temporarily widen the `branches:` list in `release.yml` and revert before merging.
````

- [ ] **Step 2: Commit**

```bash
git add CONTRIBUTING.md
git commit -m "docs: add CONTRIBUTING (release procedure + migration discipline)"
```

---

## Phase 6 — Pre-release rehearsal

This phase actually exercises the full release/upgrade/rollback path before any "real" release. Most steps run on the VPS — they cannot be done from local dev.

**Order:** merge to `master` → push `v0.0.1-rc1` → install on VPS → push `v0.0.1-rc2` → upgrade on VPS → rollback on VPS → delete the rc tags. Only then do you cut `v0.1.0`.

### Task 6.1: Merge `feature/supabase-mcp-rewrite` to `master`

**Files:** none (branch operation).

- [ ] **Step 1: Push the feature branch and open a PR**

```bash
git push -u origin feature/supabase-mcp-rewrite
gh pr create --base master --title "feat: VPS deploy + versioning pipeline" \
  --body "Implements docs/superpowers/specs/2026-05-07-vps-deploy-versioning-design.md.

## Summary
- Adds .github/workflows/release.yml (test gate + GHCR + tarball on tags).
- Bakes migrations + ingest edge function into the MCP image.
- Adds deploy/install.sh and deploy/upgrade.sh.
- Rewrites deploy/README.md for the new flow.

## Test plan
- [x] CI is green on this branch (Phase 4.2 wet test).
- [ ] Tag v0.0.1-rc1 produces image + tarball.
- [ ] Fresh install on VPS via install.sh.
- [ ] Upgrade rc1 → rc2 via upgrade.sh.
- [ ] Rollback rc2 → rc1 via upgrade.sh --rollback."
```

- [ ] **Step 2: Wait for CI green on the PR**

```bash
gh pr checks --watch
```

Note: at this point the workflow only triggers on `branches: [master]`, so the PR push itself does not run CI. You will need to either re-temporarily widen the trigger (as in Task 4.2) for the PR to validate, or accept that the next CI run will be the merge-to-master push.

- [ ] **Step 3: Merge**

```bash
gh pr merge --squash --auto
```

After auto-merge, watch the master-branch CI run:

```bash
gh run watch --exit-status
```

Expected: workflow runs on master push, all tests pass, and `:edge` + `:sha-…` images get published. Verify on GHCR:

```bash
gh api "/users/dominikx96/packages/container/oc-health-sync-plugin%2Fmcp-server/versions" \
  | jq '.[].metadata.container.tags'
```

You should see `["edge", "sha-<short>"]`.

---

### Task 6.2: Push `v0.0.1-rc1` and verify artifacts

**Files:** none (tag operation).

- [ ] **Step 1: Tag and push**

```bash
git checkout master && git pull
git tag v0.0.1-rc1
git push origin v0.0.1-rc1
gh run watch --exit-status
```

Expected: workflow runs again, builds the image with tags `v0.0.1-rc1` and `latest`, assembles the tarball, creates a GitHub release with the tarball attached.

- [ ] **Step 2: Verify the image**

```bash
gh api "/users/dominikx96/packages/container/oc-health-sync-plugin%2Fmcp-server/versions" \
  | jq '.[].metadata.container.tags' | head
```

Expected: a version exists with tags including `v0.0.1-rc1` and `latest`.

- [ ] **Step 3: Verify the release**

```bash
gh release view v0.0.1-rc1 -R dominikx96/oc-health-sync-plugin
```

Expected: release exists, has `oc-health-sync-v0.0.1-rc1.tar.gz` as an asset.

- [ ] **Step 4: Inspect the tarball locally**

```bash
gh release download v0.0.1-rc1 -R dominikx96/oc-health-sync-plugin -p '*.tar.gz' -D /tmp
tar tzf /tmp/oc-health-sync-v0.0.1-rc1.tar.gz
```

Expected file list:

```
oc-health-sync-v0.0.1-rc1/
oc-health-sync-v0.0.1-rc1/install.sh
oc-health-sync-v0.0.1-rc1/upgrade.sh
oc-health-sync-v0.0.1-rc1/docker-compose.mcp.yml
oc-health-sync-v0.0.1-rc1/init-users.sh
oc-health-sync-v0.0.1-rc1/.env.example
oc-health-sync-v0.0.1-rc1/smoke.sh
oc-health-sync-v0.0.1-rc1/README.md
oc-health-sync-v0.0.1-rc1/VERSION
```

`cat oc-health-sync-v0.0.1-rc1/VERSION` should print `v0.0.1-rc1`.

---

### Task 6.3: First-time install on the VPS

**Files:** none (operator runs commands on the VPS).

This step requires SSH access to the VPS.

- [ ] **Step 1: SSH and install prerequisites**

```bash
ssh <vps>
# On the VPS:
type -p curl >/dev/null || sudo apt-get install -y curl
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
  | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt-get update && sudo apt-get install -y gh rsync postgresql-client
gh auth login        # browser flow
```

(Skip docker / tailscale install if already done on this VPS. `postgresql-client` is needed because `init-users.sh` runs `psql` from the host.)

- [ ] **Step 2: Download and extract the tarball**

```bash
TARGET=v0.0.1-rc1
gh release download "$TARGET" \
  -R dominikx96/oc-health-sync-plugin \
  -p '*.tar.gz'
tar xzf "oc-health-sync-${TARGET}.tar.gz"
mkdir -p ~/oc-health-sync
rsync -a --exclude='.env*' --exclude='.last-version*' \
  "oc-health-sync-${TARGET}/" ~/oc-health-sync/
cd ~/oc-health-sync
```

- [ ] **Step 3: Configure `.env`**

```bash
cp .env.example .env
$EDITOR .env
```

Set every `changeme-*` to a strong unique value, including `GHCR_PAT` (a fresh PAT with `read:packages`).

- [ ] **Step 4: Run install.sh**

```bash
./install.sh v0.0.1-rc1
```

Expected: full successful run ending with `✓ Installed v0.0.1-rc1.` and tailscale-serve instructions.

- [ ] **Step 5: Configure tailscale serve**

```bash
sudo tailscale serve --bg --tcp 8000 8000
sudo tailscale serve --bg --tcp 3737 3737
tailscale serve status
```

- [ ] **Step 6: External smoke test from your laptop**

From your laptop (not the VPS), with both on the same tailnet:

```bash
TS_IP=$(tailscale ip -4 <vps-hostname>)
INGEST_URL="http://${TS_IP}:8000/functions/v1/ingest"
MCP_URL="http://${TS_IP}:3737/mcp"
INGEST_API_KEY=<from-vps-.env> MCP_API_KEY=<from-vps-.env> \
  ./deploy/smoke.sh
```

Expected: `✓ smoke test passed`.

---

### Task 6.4: Push `v0.0.1-rc2` (a no-op release)

**Files:** any trivial diff (e.g. a comment in deploy/README.md).

- [ ] **Step 1: Make a trivial change locally**

Edit `deploy/README.md` and add a single comment line at the bottom:

```
<!-- rehearsal rc2 -->
```

```bash
git add deploy/README.md
git commit -m "chore(rehearsal): trivial diff for rc2"
git push
```

- [ ] **Step 2: Wait for the master CI run**

```bash
gh run watch --exit-status
```

- [ ] **Step 3: Tag and push rc2**

```bash
git tag v0.0.1-rc2
git push origin v0.0.1-rc2
gh run watch --exit-status
```

- [ ] **Step 4: Verify the new release exists**

```bash
gh release view v0.0.1-rc2 -R dominikx96/oc-health-sync-plugin
```

---

### Task 6.5: Upgrade the VPS rc1 → rc2

**Files:** none (operator runs commands on the VPS).

- [ ] **Step 1: SSH to the VPS and upgrade**

```bash
ssh <vps>
TARGET=v0.0.1-rc2
gh release download "$TARGET" \
  -R dominikx96/oc-health-sync-plugin \
  -p '*.tar.gz'
tar xzf "oc-health-sync-${TARGET}.tar.gz"
rsync -a --exclude='.env*' --exclude='.last-version*' \
  "oc-health-sync-${TARGET}/" ~/oc-health-sync/
cd ~/oc-health-sync
./upgrade.sh "$TARGET"
```

Expected: ends with `✓ Upgraded to v0.0.1-rc2. Previous: v0.0.1-rc1 (in .last-version.bak).` and a snapshot path. Run `cat .last-version` — it should print `v0.0.1-rc2`. `cat .last-version.bak` should print `v0.0.1-rc1`. `ls ~/backups/` should show a `pre-upgrade-*.sql.gz` from the upgrade.

- [ ] **Step 2: External smoke from your laptop**

```bash
INGEST_API_KEY=... MCP_API_KEY=... ./deploy/smoke.sh
```

Expected: passes.

---

### Task 6.6: Rollback the VPS rc2 → rc1

**Files:** none.

> Note: this rehearsal exercises the *script flow* (correct env, correct image pull, correct version pointers, smoke-test still passes). It does NOT exercise a real schema rollback because rc1→rc2 only changed `deploy/README.md`. A schema-rollback rehearsal needs a separate fixture-style change and is out of scope here. Migration discipline (forward-only, backward-compatible-by-one-step — see CONTRIBUTING.md) is what makes the schema rollback case work in production.

- [ ] **Step 1: Run upgrade with --rollback**

On the VPS:

```bash
cd ~/oc-health-sync
./upgrade.sh --rollback
```

Expected: ends with `✓ Upgraded to v0.0.1-rc1. Previous: v0.0.1-rc2 (in .last-version.bak).` (note: rollback flips the two version pointers — what was `.last-version.bak` becomes `.last-version`, and what was `.last-version` becomes `.last-version.bak`).

- [ ] **Step 2: Confirm app still works**

```bash
INGEST_API_KEY=... MCP_API_KEY=... ./deploy/smoke.sh
```

Expected: passes. The MCP container is now running the rc1 image again.

- [ ] **Step 3: Re-upgrade to rc2 (so we don't leave the box on a pre-release)**

```bash
./upgrade.sh v0.0.1-rc2
```

Expected: passes. `.last-version` now reads `v0.0.1-rc2` again.

---

### Task 6.7: Clean up rehearsal tags

**Files:** none.

- [ ] **Step 1: Delete the rc tags locally and remotely**

```bash
git tag -d v0.0.1-rc1 v0.0.1-rc2
git push origin :refs/tags/v0.0.1-rc1 :refs/tags/v0.0.1-rc2
```

- [ ] **Step 2: Delete the GitHub releases**

```bash
gh release delete v0.0.1-rc1 -R dominikx96/oc-health-sync-plugin -y
gh release delete v0.0.1-rc2 -R dominikx96/oc-health-sync-plugin -y
```

- [ ] **Step 3: Optional — delete the rehearsal images from GHCR**

```bash
gh api -X DELETE "/user/packages/container/oc-health-sync-plugin%2Fmcp-server/versions/<version-id>"
```

(You can find `<version-id>` via the same `gh api ... versions` call from Task 6.2. Skip this step if you'd rather keep them as audit trail — they cost nothing.)

- [ ] **Step 4: Revert the trivial rehearsal change**

```bash
git checkout master && git pull
# Edit deploy/README.md and remove the "<!-- rehearsal rc2 -->" comment.
git commit -am "chore: drop rehearsal marker"
git push
gh run watch --exit-status
```

---

## Phase 7 — Cut v0.1.0

### Task 7.1: Tag and push the first real release

**Files:** none.

- [ ] **Step 1: Confirm master is green**

```bash
git checkout master && git pull
gh run list --workflow release.yml --limit 1
```

Expected: most recent run is on master, status `completed`, conclusion `success`.

- [ ] **Step 2: Tag v0.1.0**

```bash
git tag v0.1.0
git push origin v0.1.0
gh run watch --exit-status
```

- [ ] **Step 3: Verify the artifacts**

```bash
gh release view v0.1.0 -R dominikx96/oc-health-sync-plugin
gh api "/users/dominikx96/packages/container/oc-health-sync-plugin%2Fmcp-server/versions" \
  | jq -r '.[0].metadata.container.tags'
```

Expected: release exists with the tarball; image tags include `v0.1.0` and `latest`.

- [ ] **Step 4: Upgrade the VPS to v0.1.0**

On the VPS:

```bash
TARGET=v0.1.0
gh release download "$TARGET" \
  -R dominikx96/oc-health-sync-plugin \
  -p '*.tar.gz'
tar xzf "oc-health-sync-${TARGET}.tar.gz"
rsync -a --exclude='.env*' --exclude='.last-version*' \
  "oc-health-sync-${TARGET}/" ~/oc-health-sync/
cd ~/oc-health-sync
./upgrade.sh "$TARGET"
```

Expected: clean upgrade from `v0.0.1-rc2` → `v0.1.0`, smoke test passes, `cat .last-version` prints `v0.1.0`.

The pipeline is live.

---

## Reference: file-by-file change summary

| File | Action | Owner task |
|---|---|---|
| `mcp-server/Dockerfile` | rewrite (build context = repo root, bake migrations + ingest, add migrate entrypoint) | 1.1 |
| `mcp-server/.dockerignore` | delete | 1.2 |
| `.dockerignore` (root) | create | 1.2 |
| `mcp-server/scripts/migrate.sh` | create | 1.3 |
| `deploy/docker-compose.mcp.yml` | modify (`build:` → `image: ${MCP_IMAGE}`) | 2.1 |
| `deploy/.env.example` | append `GHCR_PAT` | 2.2 |
| `deploy/upgrade.sh` | create | 3.1 |
| `deploy/install.sh` | create | 3.2 |
| `.github/workflows/release.yml` | create | 4.1 |
| `deploy/README.md` | rewrite | 5.1 |
| `CONTRIBUTING.md` | create | 5.2 |
