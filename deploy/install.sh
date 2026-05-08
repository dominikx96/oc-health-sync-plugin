#!/usr/bin/env bash
# install.sh — one script for first install AND every subsequent upgrade.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/dominikx96/oc-health-sync-plugin/main/deploy/install.sh \
#     | bash -s -- v0.1.0
#
# Or after first install:
#   ~/oc-health-sync/install.sh v0.1.1     # upgrade
#   ~/oc-health-sync/install.sh --rollback # back to previous version
#
# All operator state (.env, .last-version, the local script copy) lives in
# ~/oc-health-sync/. Generated secrets are saved to .env on first run.

set -euo pipefail

# --- Constants -------------------------------------------------------------
OWNER="dominikx96"
REPO="oc-health-sync-plugin"
PACKAGE="mcp-server"
IMAGE_BASE="ghcr.io/${OWNER}/${REPO}/${PACKAGE}"
INSTALL_DIR="${OC_INSTALL_DIR:-$HOME/oc-health-sync}"
SUPABASE_DIR="${HOME}/supabase-base/docker"
FUNCTIONS_VOLUME="${SUPABASE_DIR}/volumes/functions/ingest"
BACKUP_DIR="${HOME}/backups"
RAW_BASE="https://raw.githubusercontent.com/${OWNER}/${REPO}/main/deploy"

# --- Args ------------------------------------------------------------------
[[ $# -eq 1 ]] || { echo "Usage: install.sh <vX.Y.Z | --rollback>" >&2; exit 2; }
TARGET="$1"

# --- Workspace -------------------------------------------------------------
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Save a local copy of this script so the operator can re-run for upgrades
# without curling each time. (When invoked via curl|bash, BASH_SOURCE points
# at /dev/stdin or similar — re-fetch in that case.)
if [[ ! -f "$INSTALL_DIR/install.sh" || "${BASH_SOURCE[0]:-}" != "$INSTALL_DIR/install.sh" ]]; then
  curl -fsSL "$RAW_BASE/install.sh" -o "$INSTALL_DIR/install.sh"
  chmod +x "$INSTALL_DIR/install.sh"
fi

# Always (re-)fetch smoke.sh so it matches the script version.
curl -fsSL "$RAW_BASE/smoke.sh" -o "$INSTALL_DIR/smoke.sh"
chmod +x "$INSTALL_DIR/smoke.sh"

# --- Mode detection --------------------------------------------------------
if [[ -f .last-version ]]; then
  MODE="upgrade"
  if [[ "$TARGET" == "--rollback" ]]; then
    [[ -s .last-version.bak ]] || { echo "FATAL: nothing to roll back to" >&2; exit 2; }
    TARGET="$(cat .last-version.bak)"
    echo "→ Rolling back to ${TARGET}"
  fi
else
  MODE="install"
  [[ "$TARGET" == "--rollback" ]] && { echo "FATAL: nothing to roll back to (first install)" >&2; exit 2; }
fi

# --- Sanity checks ---------------------------------------------------------
docker info >/dev/null 2>&1 || { echo "FATAL: docker daemon not running" >&2; exit 1; }
command -v openssl >/dev/null || { echo "FATAL: openssl required" >&2; exit 1; }
command -v git >/dev/null || { echo "FATAL: git required" >&2; exit 1; }

export MCP_IMAGE="${IMAGE_BASE}:${TARGET}"

# --- Helpers ---------------------------------------------------------------
b64url() { base64 -w 0 2>/dev/null || base64; } # macOS/linux compat

generate_jwt() {
  local secret="$1" role="$2"
  local h p s
  h=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url | tr '/+' '_-' | tr -d '=')
  p=$(printf '{"role":"%s","iss":"supabase"}' "$role" | b64url | tr '/+' '_-' | tr -d '=')
  s=$(printf '%s.%s' "$h" "$p" | openssl dgst -sha256 -hmac "$secret" -binary | b64url | tr '/+' '_-' | tr -d '=')
  printf '%s.%s.%s' "$h" "$p" "$s"
}

randhex() { openssl rand -hex "$1"; }

# --- First install: generate .env ------------------------------------------
if [[ "$MODE" == "install" && ! -f .env ]]; then
  echo "→ Generating .env with strong random defaults"
  POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(randhex 24)}"
  JWT_SECRET="${JWT_SECRET:-$(randhex 32)}"
  INGEST_API_KEY="${INGEST_API_KEY:-$(randhex 32)}"
  MCP_API_KEY="${MCP_API_KEY:-$(randhex 32)}"
  INGEST_USER_PASSWORD="${INGEST_USER_PASSWORD:-$(randhex 16)}"
  READ_USER_PASSWORD="${READ_USER_PASSWORD:-$(randhex 16)}"
  ANON_KEY="${ANON_KEY:-$(generate_jwt "$JWT_SECRET" anon)}"
  SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-$(generate_jwt "$JWT_SECRET" service_role)}"
  MCP_PORT="${MCP_PORT:-3737}"

  umask 077
  cat > .env <<EOF
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
JWT_SECRET=$JWT_SECRET
ANON_KEY=$ANON_KEY
SERVICE_ROLE_KEY=$SERVICE_ROLE_KEY
INGEST_API_KEY=$INGEST_API_KEY
MCP_API_KEY=$MCP_API_KEY
INGEST_USER_PASSWORD=$INGEST_USER_PASSWORD
READ_USER_PASSWORD=$READ_USER_PASSWORD
INGEST_DATABASE_URL=postgresql://ingest_user:$INGEST_USER_PASSWORD@db:5432/postgres
MCP_DATABASE_URL=postgresql://read_user:$READ_USER_PASSWORD@db:5432/postgres
MCP_PORT=$MCP_PORT
EOF
  echo "→ Wrote $INSTALL_DIR/.env (mode 600)"
fi

# --- Load env --------------------------------------------------------------
[[ -f .env ]] || { echo "FATAL: .env not found in $INSTALL_DIR" >&2; exit 1; }
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${POSTGRES_PASSWORD:?must be in .env}"

# --- Compose overlay (always rewrite — it's pinned by version anyway) -----
cat > docker-compose.mcp.yml <<'YAML'
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
YAML

# --- First install: clone upstream supabase, merge env --------------------
if [[ "$MODE" == "install" ]]; then
  if [[ ! -d "$HOME/supabase-base" ]]; then
    echo "→ Cloning upstream supabase compose"
    git clone --depth 1 https://github.com/supabase/supabase "$HOME/supabase-base"
    cp "${SUPABASE_DIR}/.env.example" "${SUPABASE_DIR}/.env"
  fi

  MARKER="# --- oc-health-sync overlay ---"
  if ! grep -qF "${MARKER}" "${SUPABASE_DIR}/.env"; then
    echo "→ Merging .env into ${SUPABASE_DIR}/.env"
    {
      printf '\n%s\n' "${MARKER}"
      cat .env
    } >> "${SUPABASE_DIR}/.env"
  fi
fi

# --- Compose helper --------------------------------------------------------
dc() {
  docker compose \
    --project-directory "${SUPABASE_DIR}" \
    -f "${SUPABASE_DIR}/docker-compose.yml" \
    -f "${INSTALL_DIR}/docker-compose.mcp.yml" \
    "$@"
}

# --- Upgrade: snapshot + stash version (before any state change) ----------
if [[ "$MODE" == "upgrade" ]]; then
  mkdir -p "$BACKUP_DIR"
  TS="$(date +%Y%m%d-%H%M%S)"
  SNAP="${BACKUP_DIR}/pre-upgrade-${TS}.sql.gz"
  echo "→ Snapshotting DB to ${SNAP}"
  docker exec supabase-db pg_dump -U postgres postgres | gzip > "${SNAP}"
  [[ -s "${SNAP}" ]] || { echo "FATAL: snapshot is empty" >&2; exit 1; }
  gunzip -t "${SNAP}" || { echo "FATAL: snapshot is corrupt" >&2; exit 1; }

  CURRENT="$(cat .last-version)"
  echo "${CURRENT}" > .last-version.bak
  echo "→ Previous version stashed: ${CURRENT}"
fi

# --- Pull image ------------------------------------------------------------
echo "→ Pulling ${MCP_IMAGE}"
dc pull mcp

# --- Install: bring up infra (no mcp yet — read_user doesn't exist) -------
# We use --no-deps for kong/functions to skip the upstream analytics service.
# Analytics is logflare (~500MB resident) and is observability-only — kong
# routes and functions runs without it. Skipping kills a known startup race
# (analytics needs a "_supabase" DB the postgres init scripts create after
# pg_isready returns yes).
if [[ "$MODE" == "install" ]]; then
  echo "→ Starting db"
  dc up -d db

  echo "→ Waiting for Postgres"
  for _ in $(seq 1 60); do
    docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1 \
    || { echo "FATAL: Postgres did not become ready in 60s" >&2; exit 1; }

  echo "→ Starting kong, functions (skipping unused supabase analytics)"
  dc up -d --no-deps kong functions
fi

# --- Migrate (always, fail-fast before any restart) -----------------------
echo "→ Running migrations"
dc run --rm \
  -e MCP_DATABASE_URL="postgresql://postgres:${POSTGRES_PASSWORD}@db:5432/postgres" \
  --entrypoint /usr/local/bin/migrate \
  mcp

# --- Install: create login users -----------------------------------------
if [[ "$MODE" == "install" ]]; then
  echo "→ Creating login users (ingest_user, read_user)"
  docker exec -i \
    -e PGPASSWORD="${POSTGRES_PASSWORD}" \
    supabase-db \
    psql -U postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingest_user') THEN
    CREATE ROLE ingest_user LOGIN PASSWORD '${INGEST_USER_PASSWORD}';
  ELSE
    ALTER ROLE ingest_user WITH PASSWORD '${INGEST_USER_PASSWORD}';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_user') THEN
    CREATE ROLE read_user LOGIN PASSWORD '${READ_USER_PASSWORD}';
  ELSE
    ALTER ROLE read_user WITH PASSWORD '${READ_USER_PASSWORD}';
  END IF;
END \$\$;
GRANT health_ingest_role TO ingest_user;
GRANT health_read_role   TO read_user;
SQL
fi

# --- Sync edge function code from image to host volume -------------------
echo "→ Syncing edge function code"
CID="$(docker create "${MCP_IMAGE}")"
trap 'docker rm "${CID}" >/dev/null 2>&1 || true' EXIT
mkdir -p "${FUNCTIONS_VOLUME}"
if [[ "$MODE" == "upgrade" ]]; then
  rm -rf "${FUNCTIONS_VOLUME:?}"/*
fi
docker cp "${CID}":/release/functions/ingest/. "${FUNCTIONS_VOLUME}/"
docker rm "${CID}" >/dev/null
trap - EXIT

# --- Bring everything up --------------------------------------------------
# --no-deps everywhere to keep analytics + other unused upstream services
# (storage, realtime, auth, rest, imgproxy, vector, meta, studio) from starting.
if [[ "$MODE" == "install" ]]; then
  echo "→ Starting mcp"
  dc up -d --no-deps mcp
else
  echo "→ Restarting mcp + functions"
  dc up -d --force-recreate --no-deps mcp functions
fi

# --- Smoke ----------------------------------------------------------------
echo "→ Smoke test"
./smoke.sh

# --- Commit version pointer -----------------------------------------------
echo "${TARGET}" > .last-version

# --- Final report ---------------------------------------------------------
if [[ "$MODE" == "install" ]]; then
  cat <<EOF

✓ Installed ${TARGET}.

Generated secrets are in $INSTALL_DIR/.env (mode 600). Save these:
  MCP_API_KEY    (for your MCP client)  : $MCP_API_KEY
  INGEST_API_KEY (for the iOS app)      : $INGEST_API_KEY

Next:
  sudo tailscale serve --bg --tcp 8000 8000
  sudo tailscale serve --bg --tcp ${MCP_PORT} ${MCP_PORT}

To upgrade later:
  $INSTALL_DIR/install.sh vX.Y.Z

To roll back:
  $INSTALL_DIR/install.sh --rollback
EOF
else
  echo "✓ Upgraded to ${TARGET}. Previous: ${CURRENT} (stashed in .last-version.bak)"
  echo "  Snapshot: ${SNAP}"
fi
