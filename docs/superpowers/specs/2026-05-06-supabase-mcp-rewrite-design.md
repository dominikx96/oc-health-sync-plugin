# oc-health-sync — Supabase + MCP Rewrite

**Date:** 2026-05-06
**Status:** Approved (brainstorming complete, awaiting implementation plan)
**Author:** Dominik Barcikowski (with Claude)

## Context

The existing `oc-health-sync` is an OpenClaw plugin: it ingests Apple HealthKit data over a localhost HTTP route, stores it in a local SQLite database via `node:sqlite`, and exposes six agent tools that an OpenClaw agent can call.

We are pivoting away from OpenClaw. The new project replaces the runtime with self-hosted Supabase (Postgres + Edge Functions) and replaces the agent-tool surface with an MCP server, so the system is usable by any MCP-compatible client (Claude Desktop, Hermes, Cursor, VS Code MCP, etc.). Everything runs on a single VPS, isolated to a Tailscale tailnet.

The existing code is reference material only. It will be moved to `_legacy/` during the rewrite and deleted once the new system is functional.

## Goals

1. Ingest Apple HealthKit data sent from the iOS app to Supabase, with the same payload contract and idempotency guarantees as the old plugin.
2. Expose health-data analytical capabilities through a standards-compliant MCP server, usable by any MCP client.
3. Self-host the entire stack on a single VPS with Docker Compose.
4. Keep all inbound traffic — iOS uploads and MCP client connections — on the tailnet. Nothing public.
5. Single-user deployment. No multi-user complexity.

## Non-goals

- Multi-user support, user accounts, Supabase Auth/GoTrue.
- Public-internet exposure of any service (no Tailscale Funnel, no domain, no TLS termination).
- Automatic migration of data from the old SQLite database. Fresh start; user re-syncs from iOS.
- Realtime subscriptions, file storage, or other Supabase services beyond Postgres + Edge Functions.
- Automatic Supabase version upgrades. Operator handles those manually.
- Compatibility with the old OpenClaw plugin format. The OpenClaw integration is removed entirely.

## Architecture

### Topology

```
┌──────────┐  Tailscale   ┌──────────────────────────────────────────┐
│  iPhone  │─────────────▶│           VPS (tailnet only)             │
└──────────┘  POST ingest │                                          │
                          │  ┌──────────────────────────────────┐    │
                          │  │ Supabase (self-hosted, Docker)   │    │
                          │  │  ┌────────────┐  ┌────────────┐  │    │
                          │  │  │ Kong/HTTP  │─▶│ Edge Fn:   │  │    │
                          │  │  │  gateway   │  │  ingest    │  │    │
                          │  │  └────────────┘  └─────┬──────┘  │    │
                          │  │                        │ SQL     │    │
                          │  │              ┌─────────▼──────┐  │    │
                          │  │              │   Postgres     │  │    │
                          │  │              │  (samples +    │  │    │
                          │  │              │   views/fns)   │  │    │
                          │  │              └─────────▲──────┘  │    │
                          │  └────────────────────────┼─────────┘    │
                          │                           │ SQL          │
                          │  ┌────────────────────────┴─────────┐    │
                          │  │  MCP Server (Node, TS)           │    │
                          │  │  Streamable HTTP, bearer auth    │    │
                          │  └────────────────────────▲─────────┘    │
                          └─────────────────────────────────────────-┘
                                                     │ Tailscale
                                              ┌──────┴──────┐
                                              │ MCP client  │
                                              │ (Claude/    │
                                              │  Hermes/    │
                                              │  Cursor…)   │
                                              └─────────────┘
```

All services bind to `127.0.0.1` (or the Docker network). Tailscale's `tailscale serve --bg --tcp` exposes the Kong gateway port (for ingest) and the MCP server port (for MCP clients) to the tailnet only.

### Repository layout

```
oc-health-sync/
├── supabase/
│   ├── config.toml
│   ├── migrations/
│   │   └── 20260506000000_init.sql
│   └── functions/
│       └── ingest/
│           └── index.ts
├── mcp-server/
│   ├── src/
│   │   ├── index.ts
│   │   ├── auth.ts
│   │   ├── db.ts
│   │   ├── tools/
│   │   │   ├── health-summary.ts
│   │   │   ├── health-anomalies.ts
│   │   │   └── run-sql.ts
│   │   └── resources/
│   │       └── schema.ts
│   ├── package.json
│   └── tsconfig.json
├── deploy/
│   ├── docker-compose.yml
│   ├── .env.example
│   └── README.md
├── docs/
│   └── superpowers/specs/...
├── _legacy/
└── README.md
```

The two top-level deliverables are the **Supabase project** (`supabase/`) and the **MCP server** (`mcp-server/`). `deploy/` glues them together for VPS hosting.

## Components

### 1. Database schema (Postgres)

Three tables, ported from the old SQLite schema with soft-delete and dedup semantics preserved:

```sql
CREATE TABLE health_samples (
  id           BIGSERIAL PRIMARY KEY,
  uuid         TEXT NOT NULL UNIQUE,
  sample_kind  TEXT NOT NULL,                   -- quantity | category | workout
  data_type    TEXT NOT NULL,
  value        DOUBLE PRECISION,
  unit         TEXT,
  start_date   TIMESTAMPTZ NOT NULL,
  end_date     TIMESTAMPTZ NOT NULL,
  source_name  TEXT,
  metadata     JSONB,
  device_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);
CREATE INDEX idx_samples_data_type_start
  ON health_samples (data_type, start_date) WHERE deleted_at IS NULL;
CREATE INDEX idx_samples_start_date
  ON health_samples (start_date) WHERE deleted_at IS NULL;

CREATE TABLE device_state (
  device_id      TEXT PRIMARY KEY,
  last_anchor    TEXT,
  last_synced_at TIMESTAMPTZ,
  metadata       JSONB
);

CREATE TABLE summary_cache (
  cache_key    TEXT PRIMARY KEY,
  markdown     TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated  BOOLEAN NOT NULL DEFAULT false
);
-- cache_key format:
--   daily:YYYY-MM-DD:<tz>
--   weekly:YYYY-Www:<tz>
--   monthly:YYYY-MM:<tz>
```

Analytical logic lives in views and functions, not in the MCP server:

- `daily_metrics(tz TEXT)`, `weekly_metrics(tz TEXT)`, `monthly_metrics(tz TEXT)` — views with per-bucket aggregations (avg HR, total steps, sleep total, HRV mean, workout summary), tz-aware via `start_date AT TIME ZONE tz`.
- `data_completeness(start TIMESTAMPTZ, end_at TIMESTAMPTZ, tz TEXT)` — function returning per-day counts by `data_type` with gaps flagged.
- `detect_anomalies(window_days INT)` — function returning rows of `{kind, severity, detail}` for HRV decline (>15% vs 30-day baseline), sleep deficit (<6h three consecutive nights), resting HR spike, and low step days. Thresholds ported from the legacy `src/tools/anomalies.ts`.

Two database roles:

- `health_ingest_role` — used by the Edge Function. INSERT/UPDATE on `health_samples` and `device_state`. UPDATE on `summary_cache.invalidated`.
- `health_read_role` — used by the MCP server. SELECT on `health_samples`, `device_state`, all views; EXECUTE on read-only functions; INSERT/UPDATE/SELECT on `summary_cache` (and only that table); **no privileges on `health_samples` or `device_state` writes; no DDL**. Backs both the `run_sql` tool (where queries against the data tables are read-only) and the `health_summary` tool (which writes its own cache rows). Markdown templates stay in TS for testability; the database constraint enforces that arbitrary `run_sql` queries cannot mutate health data.

### 2. Ingest Edge Function

A single Deno function at `supabase/functions/ingest/index.ts`:

- **Endpoint:** `POST /functions/v1/ingest`
- **Auth:** `Authorization: Bearer <INGEST_API_KEY>`. Validated against the `INGEST_API_KEY` env var with timing-safe compare.
- **Body schema** (same as the old plugin):
  ```json
  {
    "device_id": "string",
    "new_samples": [
      {
        "uuid": "string",
        "sample_kind": "quantity|category|workout",
        "data_type": "HKQuantityTypeIdentifier...",
        "value": 0,
        "unit": "string",
        "start_date": "ISO-8601",
        "end_date": "ISO-8601",
        "source_name": "string",
        "metadata": { }
      }
    ],
    "deleted_ids": ["uuid", ...]
  }
  ```
- **Logic:**
  1. Validate bearer token.
  2. Validate body shape (lightweight, e.g. `zod`).
  3. Bulk upsert `new_samples`: `INSERT … ON CONFLICT (uuid) DO UPDATE` so iOS retries are idempotent.
  4. Soft-delete `deleted_ids`: `UPDATE health_samples SET deleted_at = now() WHERE uuid = ANY($1)`.
  5. Mark affected `summary_cache` rows as invalidated for the date range touched by the payload.
  6. Update `device_state` (`last_synced_at`, anchor, metadata).
  7. Return `{ stored: <count>, deleted: <count> }`.
- **Response codes:** 200 ok, 401 unauthorized, 400 validation error, 500 server.
- **Connects to Postgres** directly via `postgres-js` (Deno-compatible) using a connection string scoped to `health_ingest_role`. Avoids the Supabase JS client / PostgREST round-trip; the function is the only writer to the data tables and benefits from being able to issue raw SQL with `ON CONFLICT` and `= ANY($1)` clauses.

### 3. MCP server

A Node 24 / TypeScript service using the official `@modelcontextprotocol/sdk` (Anthropic).

- **Transport:** Streamable HTTP. Listens on `127.0.0.1:<MCP_PORT>` inside the Docker network; Tailscale's `serve --bg --tcp` exposes the port to the tailnet.
- **Auth:** custom HTTP middleware in front of the SDK handler. `Authorization: Bearer <MCP_API_KEY>`. Timing-safe compare. Requests without a valid token are rejected with 401 before the SDK handler runs.
- **DB access:** `pg` (node-postgres) connection pool, connected as `health_read_role`. One pool per process.

**Tools:**

| Tool name | Inputs | Behavior |
|---|---|---|
| `health_summary` | `{ period: 'day' \| 'week' \| 'month', date?: string (ISO date), tz?: string (IANA) }` | Reads from `daily_metrics` / `weekly_metrics` / `monthly_metrics` views. Renders markdown via templates ported from `src/summary/templates.ts`. Looks up `summary_cache` first: returns cached markdown if `invalidated = false`, otherwise regenerates and upserts. Cache writes are scoped to the `summary_cache` table (the only table `health_read_role` can write). |
| `health_anomalies` | `{ window_days?: number }` (default 14) | Calls `detect_anomalies(window_days)`, formats results as a markdown bulleted list with severity tags. |
| `run_sql` | `{ query: string }` | Executes the query as `health_read_role`. Enforces a statement timeout (5s). Enforces a single statement (rejects multi-statement queries client-side). Returns rows as JSON. |

**Resources:**

| URI | Returns |
|---|---|
| `schema://tables` | Machine-readable description of tables, columns, views, and functions, plus example queries. The LLM uses this to construct `run_sql` queries. |

**Dropped tools** (relative to the legacy six): `health_query`, `health_raw`, `health_compare`, `health_completeness`. All trivially expressible via `run_sql` once the schema resource is available. They can be added back as canned tools if real-world usage shows them to be high-frequency.

### 4. Auth model

Two independent bearer tokens, both env-driven, both validated via timing-safe compare:

| Token | Purpose | Where used | Where stored |
|---|---|---|---|
| `INGEST_API_KEY` | iOS → Edge Function | `Authorization` header on `/functions/v1/ingest` | Edge Function env, iOS Keychain |
| `MCP_API_KEY` | MCP client → MCP server | `Authorization` header on Streamable HTTP endpoint | MCP server env, client config |

No Supabase Auth/GoTrue. No user accounts. RLS not used (single-user; the Edge Function uses a service role and the MCP server uses a read-only role). Network isolation via Tailscale is the primary defense; bearer tokens are belt-and-suspenders.

### 5. Deployment

- `deploy/docker-compose.yml` extends Supabase's official self-hosted compose with our MCP server as an additional service on the same Docker network (so the MCP server reaches Postgres on its internal hostname, not via Kong).
- Disabled Supabase services: GoTrue (Auth), Realtime, Storage. Studio kept (web admin convenience over the tailnet).
- `deploy/.env.example` lists every required env: `POSTGRES_PASSWORD`, `JWT_SECRET`, `INGEST_API_KEY`, `MCP_API_KEY`, plus standard Supabase self-host vars.
- `deploy/README.md` documents the VPS bootstrap: install Docker, install Tailscale, `cp .env.example .env`, edit, `docker-compose up -d`, run migrations, then `tailscale serve --bg --tcp <kong-port> <kong-port>` and `tailscale serve --bg --tcp <mcp-port> <mcp-port>` to expose to the tailnet.
- iOS-app side: README documents the new ingest URL (`http://<tailnet-ip>:<kong-port>/functions/v1/ingest`) and the new bearer-token configuration.

## Data flow

**Ingest:**
1. iOS app collects a batch of HealthKit samples since the last sync anchor.
2. iOS POSTs to `http://<tailnet-ip>:<kong-port>/functions/v1/ingest` over Tailscale with `Authorization: Bearer $INGEST_API_KEY`.
3. Kong routes the request to the `ingest` Edge Function.
4. Edge Function validates auth, validates body, upserts samples, soft-deletes, invalidates cache, updates device state.
5. Edge Function returns `{ stored, deleted }`.
6. iOS persists the new sync anchor.

**Query (via MCP):**
1. MCP client (e.g. Claude Desktop) connects over Tailscale to the MCP server's Streamable HTTP endpoint with `Authorization: Bearer $MCP_API_KEY`.
2. The user asks the LLM a question.
3. The LLM calls one of the tools (`health_summary`, `health_anomalies`, or `run_sql`) — possibly first reading the `schema://tables` resource if it intends to use `run_sql`.
4. The MCP server queries Postgres as `health_read_role` and returns the result to the LLM.
5. The LLM formulates a response using the tool result.

## Error handling

- **Edge Function:** structured JSON errors `{ error: { code, message } }`. 401 for auth. 400 for body validation. 500 for unexpected, with the exception logged. Never returns row-level details for 500s. Database errors caught and translated to 500.
- **MCP server:** SDK-native error responses for tool failures. `run_sql` returns the underlying Postgres error message verbatim (helpful for the LLM to self-correct). Auth failures return HTTP 401 before the SDK is invoked.
- **Cache invalidation race:** if a query and an ingest race, the worst case is serving a stale cached summary once. The next request after the ingest completes regenerates. Acceptable for single-user.
- **Statement timeout:** `run_sql` enforces a 5-second timeout via `SET LOCAL statement_timeout`. Long-running query attempts are killed by Postgres.

## Testing strategy

- **MCP server unit tests:** Vitest. DB layer mocked. Each tool tested for input validation, parameter binding, error shapes. The `run_sql` tool tested for the multi-statement rejection and timeout.
- **Edge Function tests:** Deno test runner. Tests run against a real Postgres via testcontainers (or a dedicated `docker-compose.test.yml`). Cases: dedup on retry, soft-delete, cache invalidation on touched dates, malformed body rejection, bad auth rejection.
- **Schema/migration tests:** apply migrations to an empty Postgres in CI, snapshot the resulting schema (`pg_dump --schema-only`), assert against a checked-in expected dump. Catches accidental schema drift.
- **End-to-end smoke test:** `deploy/smoke.sh` posts a sample payload to the local stack, then calls `health_summary` via the MCP server and asserts the data appears. Run after any deployment.

## Migration from legacy code

Worth porting from `_legacy/`:

- Anomaly thresholds and heuristics from `src/tools/anomalies.ts` → `detect_anomalies()` SQL function.
- Markdown summary templates from `src/summary/templates.ts` → MCP server `health_summary` tool.
- Sleep-stage / workout-name / metric constants from `src/utils/constants.ts` → shared TS module under `mcp-server/src/`.
- The agent identity (`agent/IDENTITY.md`) → a section of the new `README.md` so users can paste it into whichever MCP client they use.

Dropped: OpenClaw plugin entry point, `openclaw.plugin.json`, the OpenClaw skill format, all OpenClaw-specific code, and the `node:sqlite` connection layer.

## Open items

- **Studio:** kept enabled by default in the compose file. Operator can disable in `.env` if undesired.
- **iOS app changes:** out of scope for this repo. The iOS app needs an updated server URL and bearer-token configuration; that work happens in the iOS repo.

## Appendix: SDK choice rationale

The official `@modelcontextprotocol/sdk` (Anthropic) was chosen over alternatives:

- **Vercel `@vercel/mcp-adapter`:** designed for Vercel Edge runtime and Next.js. We are self-hosting on a VPS as a long-running Node process; using this would mean fighting the framework.
- **`fastmcp`, `mcp-framework`:** community-maintained convenience layers over the official SDK. The official SDK is sufficient for our small surface (3 tools, 1 resource); a wrapper would add a dependency without commensurate benefit.

The official SDK is the reference implementation, kept in lockstep with the spec, supports stdio (useful for local dev) and Streamable HTTP (the deployed transport), and is TypeScript-native.
