#!/usr/bin/env bash
# init-users.sh — create login users (ingest_user, read_user) with passwords from
# .env, and grant them the role memberships defined by the migrations.
#
# Idempotent: re-running rotates passwords on existing users without error.
# Connects via `docker exec supabase-db psql` so the script works regardless of
# the upstream supabase compose's host port mapping.

set -euo pipefail

: "${INGEST_USER_PASSWORD:?must be set in .env}"
: "${READ_USER_PASSWORD:?must be set in .env}"
: "${POSTGRES_PASSWORD:?must be set in .env}"

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

echo "✓ users created"
