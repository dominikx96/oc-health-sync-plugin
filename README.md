# oc-health-sync

Self-hosted Supabase + MCP server for ingesting Apple HealthKit data and exposing it to MCP-compatible clients (Claude Desktop, Hermes, Cursor, etc.). Runs on a single VPS, isolated to a Tailscale tailnet.

- **Ingest:** the iOS app POSTs HealthKit samples to a Supabase Edge Function over Tailscale.
- **Query:** any MCP client connects to the MCP server (over Tailscale) to call `health_summary`, `health_anomalies`, or `run_sql`, and to read the `schema://tables` resource.
- **No public exposure** — everything is tailnet-only.

## Layout

- `supabase/` — SQL migrations, the `ingest` Edge Function, seed data.
- `mcp-server/` — Node 24 + TypeScript MCP server (`@modelcontextprotocol/sdk`).
- `deploy/` — `docker-compose.mcp.yml`, `.env.example`, deploy guide, smoke test.

## Deploying

See [`deploy/README.md`](./deploy/README.md).

## Development

```bash
# 1. Bring up local Supabase (Postgres + Studio + Edge Functions runtime)
cd supabase && supabase start

# 2. Apply migrations and seed
supabase db reset

# 3. Create a local env file for the Edge Function
#    (the function runs in a container, so use host.docker.internal not 127.0.0.1)
cat > supabase/functions/ingest/.env <<'EOF'
INGEST_API_KEY=test-ingest-key
INGEST_DATABASE_URL=postgresql://ingest_user:ingest_pw@host.docker.internal:54422/postgres
EOF

# 4. Run the Edge Function locally
supabase functions serve ingest --no-verify-jwt \
  --env-file ./supabase/functions/ingest/.env

# 5. In another terminal, run the MCP server
cd mcp-server
MCP_API_KEY=mcp-test-key \
MCP_DATABASE_URL='postgresql://read_user:read_pw@127.0.0.1:54422/postgres' \
npm run dev
```

See [`supabase/functions/ingest/README.md`](./supabase/functions/ingest/README.md) for more detail on the Edge Function local setup.

Tests:

The handler and MCP tool tests hit the local Postgres directly and assume a clean database state. Always run `supabase db reset` first:

```bash
# Refresh DB (applies migrations + seed.sql)
cd supabase && supabase db reset && cd ..

# Schema tests
for t in supabase/tests/*.test.sql; do
  psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f "$t" || exit 1
done

# Edge Function tests
cd supabase/functions/ingest && deno test --allow-env --allow-net --allow-read

# MCP server tests
cd mcp-server && npm test
```

## Dependencies note

The MCP server pins `@modelcontextprotocol/{server,express,node}` at `2.0.0-alpha.2`. These are pre-release packages on an unstable API surface; the pin is intentional to avoid drift. Plan to migrate to the stable SDK release once it ships.

## MCP client identity prompt

For best results, your MCP client should be configured with a "Health Analyst" persona. Suggested identity:

> You are a personal health data analyst. You have access to the user's Apple HealthKit data via the `oc-health-sync` MCP server. Lead with the most relevant finding. Compare current values to recent trends. Flag anomalies proactively. Use exact numbers with units. Never diagnose or prescribe — report what the data shows.

For gym tracking, configure a second "Gym Coach" skill or persona that uses the `gym_*` tools. See `skill_example/gym-coach/SKILL.md` for a starting point. The MCP server exposes both surfaces from the same endpoint — clients can route based on intent.
