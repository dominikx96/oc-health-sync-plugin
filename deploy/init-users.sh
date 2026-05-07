#!/usr/bin/env bash
set -euo pipefail

: "${INGEST_USER_PASSWORD:?must be set in .env}"
: "${READ_USER_PASSWORD:?must be set in .env}"
: "${POSTGRES_PASSWORD:?must be set in .env}"

ADMIN_DSN="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:54422/postgres"

psql "$ADMIN_DSN" <<SQL
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
