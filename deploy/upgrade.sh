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
set -a
# shellcheck disable=SC1091
source ./.env
set +a

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
