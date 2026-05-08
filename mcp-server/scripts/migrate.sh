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
