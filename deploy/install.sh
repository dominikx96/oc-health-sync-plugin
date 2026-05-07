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

set -a
# shellcheck disable=SC1091
source ./.env
set +a

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
