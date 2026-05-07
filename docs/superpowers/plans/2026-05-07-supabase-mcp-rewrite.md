# oc-health-sync Supabase + MCP Rewrite — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the OpenClaw plugin with a self-hosted Supabase + MCP server stack that ingests Apple HealthKit data via an Edge Function and exposes health-data analytical tools through MCP, all running on a single VPS isolated to a Tailscale tailnet.

**Architecture:** Two top-level deliverables — a Supabase project (`supabase/`: SQL migrations, Edge Functions) and an MCP server (`mcp-server/`: Node 24 + TypeScript using the official `@modelcontextprotocol/sdk`). A `deploy/` folder glues them with Docker Compose. Existing code is moved to `_legacy/` during the rewrite and deleted at the end.

**Tech Stack:** Postgres 15 (Supabase), Deno (Edge Functions), Node 24 + TypeScript (MCP server), `@modelcontextprotocol/server` + `/express` + `/node`, `pg` (node-postgres), Zod, Vitest, `deno test`, Docker Compose, Tailscale.

**Reference spec:** `docs/superpowers/specs/2026-05-06-supabase-mcp-rewrite-design.md`. Read it before starting — every task in this plan corresponds to something in that spec.

**Conventions:**
- Run all commands from the repo root (`oc-health-sync-plugin/`) unless otherwise stated.
- Commits use short imperative-mood subjects, optionally prefixed `feat:` / `fix:` / `refactor:` / `chore:` / `docs:` / `test:` matching the project's existing history.
- Database tests assume `supabase start` has been run once locally; that gives Postgres at `127.0.0.1:54322`, user `postgres`, password `postgres`, DB `postgres`.
- Whenever a step says "run X and expect Y", actually run it and verify before checking the box.

---

## Phase 0 — Workspace Setup

### Task 0.1: Move legacy code aside and create new layout

**Files:**
- Move: every existing top-level item except `.git/`, `.gitignore`, `.claude/`, `agent_example/`, `docs/`, `node_modules/` into `_legacy/`
- Create directories: `supabase/`, `mcp-server/`, `deploy/`

- [ ] **Step 1: Create `_legacy/` and move old code**

```bash
mkdir _legacy
git mv src _legacy/src
git mv agent _legacy/agent
git mv agent_legacy _legacy/agent_legacy
git mv skills _legacy/skills
git mv scripts _legacy/scripts
git mv dist _legacy/dist 2>/dev/null || true
git mv openclaw.plugin.json _legacy/openclaw.plugin.json
git mv package.json _legacy/package.json
git mv package-lock.json _legacy/package-lock.json
git mv tsconfig.json _legacy/tsconfig.json
git mv RELEASING.md _legacy/RELEASING.md
git mv README.md _legacy/README.md
```

- [ ] **Step 2: Verify the move**

Run: `ls`
Expected: only `.claude/`, `.gitignore`, `_legacy/`, `agent_example/`, `docs/`, `node_modules/` remain at root (plus `.git/`).

- [ ] **Step 3: Create new top-level directories**

```bash
mkdir -p supabase mcp-server/src deploy
```

- [ ] **Step 4: Add a placeholder root README so the repo isn't bare**

Create `README.md`:

```markdown
# oc-health-sync

Self-hosted Supabase + MCP stack for ingesting Apple HealthKit data and exposing it to MCP clients. See `docs/superpowers/specs/2026-05-06-supabase-mcp-rewrite-design.md` for the design.

This repo is mid-rewrite; the previous OpenClaw plugin lives in `_legacy/` and will be removed when the new stack is functional.
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: move legacy plugin to _legacy/, scaffold new layout"
```

---

### Task 0.2: Initialize the Supabase project

**Files:**
- Create: `supabase/config.toml`, `supabase/.gitignore`
- Create: `supabase/migrations/` (empty)
- Create: `supabase/functions/` (empty)

- [ ] **Step 1: Confirm Supabase CLI is installed**

Run: `supabase --version`
Expected: prints a version (≥ 1.200). If missing, install via `brew install supabase/tap/supabase`.

- [ ] **Step 2: Initialize the project inside the existing repo**

```bash
cd supabase
supabase init --workdir .
cd ..
```

This creates `supabase/config.toml`. If it tries to create a parent `supabase/` it's already there — fine.

- [ ] **Step 3: Set the project ID**

Edit `supabase/config.toml` so the `project_id` is `oc_health_sync`. Other values keep defaults.

- [ ] **Step 4: Start Supabase locally to confirm it works**

```bash
cd supabase
supabase start
cd ..
```

Expected: prints a list of service URLs (API, Studio, DB). Note the DB URL — it should be `postgresql://postgres:postgres@127.0.0.1:54322/postgres`.

- [ ] **Step 5: Stop Supabase and commit**

```bash
cd supabase
supabase stop
cd ..
git add supabase/
git commit -m "chore: init supabase project"
```

---

### Task 0.3: Initialize the MCP server npm package

**Files:**
- Create: `mcp-server/package.json`
- Create: `mcp-server/tsconfig.json`
- Create: `mcp-server/vitest.config.ts`
- Create: `mcp-server/src/index.ts` (placeholder)
- Create: `mcp-server/.gitignore`

- [ ] **Step 1: Create `mcp-server/package.json`**

```json
{
  "name": "@oc-health-sync/mcp-server",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=24"
  },
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "tsx watch src/index.ts",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/express": "*",
    "@modelcontextprotocol/node": "*",
    "@modelcontextprotocol/server": "*",
    "express": "^4.21.0",
    "pg": "^8.13.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^22.0.0",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

After saving, replace the `*` for each `@modelcontextprotocol/*` dep with the latest concrete version: `cd mcp-server && npm view @modelcontextprotocol/server version` etc., then pin them in `package.json`.

- [ ] **Step 2: Create `mcp-server/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2023"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["dist", "node_modules", "src/**/*.test.ts"]
}
```

- [ ] **Step 3: Create `mcp-server/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
});
```

- [ ] **Step 4: Create placeholder `mcp-server/src/index.ts`**

```typescript
console.log('mcp-server placeholder — implement in later tasks');
```

- [ ] **Step 5: Create `mcp-server/.gitignore`**

```
dist/
node_modules/
*.log
```

- [ ] **Step 6: Install dependencies and verify build**

```bash
cd mcp-server
npm install
npm run typecheck
cd ..
```

Expected: `npm install` succeeds, `npm run typecheck` exits 0.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/
git commit -m "chore: scaffold mcp-server package"
```

---

## Phase 1 — Database Schema

All migrations live in `supabase/migrations/` with timestamp prefixes. Apply them locally with `supabase db reset` (which rebuilds the local DB from migrations and seed). Always run `supabase start` first.

### Task 1.1: Initial migration — tables and indexes

**Files:**
- Create: `supabase/migrations/20260507000000_init_tables.sql`
- Create: `supabase/tests/schema.test.sql` (pgTAP-style test, run via psql)

- [ ] **Step 1: Write the failing schema test first**

Create `supabase/tests/schema.test.sql`:

```sql
-- Verifies the three expected tables exist with the right columns.
DO $$
BEGIN
  -- health_samples
  PERFORM 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'health_samples';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_samples missing'; END IF;

  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'health_samples'
     AND column_name = 'uuid' AND is_nullable = 'NO';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_samples.uuid missing or nullable'; END IF;

  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'health_samples'
     AND column_name = 'deleted_at';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_samples.deleted_at missing'; END IF;

  -- device_state
  PERFORM 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'device_state';
  IF NOT FOUND THEN RAISE EXCEPTION 'device_state missing'; END IF;

  -- summary_cache
  PERFORM 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'summary_cache';
  IF NOT FOUND THEN RAISE EXCEPTION 'summary_cache missing'; END IF;

  -- partial index on health_samples
  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename = 'health_samples'
     AND indexname = 'idx_samples_data_type_start';
  IF NOT FOUND THEN RAISE EXCEPTION 'idx_samples_data_type_start missing'; END IF;

  RAISE NOTICE 'schema.test.sql OK';
END $$;
```

- [ ] **Step 2: Run the test against the empty local DB to confirm it fails**

```bash
supabase start
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/schema.test.sql
```

Expected: `ERROR: health_samples missing`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260507000000_init_tables.sql`:

```sql
-- Health samples: one row per HealthKit sample, soft-deleted via deleted_at.
CREATE TABLE health_samples (
  id           BIGSERIAL PRIMARY KEY,
  uuid         TEXT NOT NULL UNIQUE,
  sample_kind  TEXT NOT NULL CHECK (sample_kind IN ('quantity', 'category', 'workout')),
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
  ON health_samples (data_type, start_date)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_samples_start_date
  ON health_samples (start_date)
  WHERE deleted_at IS NULL;

-- Device sync state: one row per device that has ever uploaded.
CREATE TABLE device_state (
  device_id      TEXT PRIMARY KEY,
  last_anchor    TEXT,
  last_synced_at TIMESTAMPTZ,
  metadata       JSONB
);

-- Cache of rendered markdown summaries.
-- cache_key formats:
--   daily:YYYY-MM-DD:<tz>
--   weekly:YYYY-Www:<tz>
--   monthly:YYYY-MM:<tz>
CREATE TABLE summary_cache (
  cache_key    TEXT PRIMARY KEY,
  markdown     TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated  BOOLEAN NOT NULL DEFAULT false
);
```

- [ ] **Step 4: Apply migrations and re-run the test**

```bash
supabase db reset
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/schema.test.sql
```

Expected: `NOTICE: schema.test.sql OK`. Exit code 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260507000000_init_tables.sql supabase/tests/schema.test.sql
git commit -m "feat(db): add health_samples, device_state, summary_cache tables"
```

---

### Task 1.2: Roles and grants

**Files:**
- Create: `supabase/migrations/20260507000100_roles.sql`
- Create: `supabase/tests/roles.test.sql`

- [ ] **Step 1: Write the failing roles test**

Create `supabase/tests/roles.test.sql`:

```sql
DO $$
BEGIN
  PERFORM 1 FROM pg_roles WHERE rolname = 'health_ingest_role';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_ingest_role missing'; END IF;

  PERFORM 1 FROM pg_roles WHERE rolname = 'health_read_role';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_read_role missing'; END IF;

  -- read role must NOT have INSERT on health_samples
  IF has_table_privilege('health_read_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role should not have INSERT on health_samples';
  END IF;

  -- read role MUST have SELECT on health_samples
  IF NOT has_table_privilege('health_read_role', 'public.health_samples', 'SELECT') THEN
    RAISE EXCEPTION 'health_read_role missing SELECT on health_samples';
  END IF;

  -- read role MUST have INSERT/UPDATE on summary_cache
  IF NOT has_table_privilege('health_read_role', 'public.summary_cache', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role missing INSERT on summary_cache';
  END IF;
  IF NOT has_table_privilege('health_read_role', 'public.summary_cache', 'UPDATE') THEN
    RAISE EXCEPTION 'health_read_role missing UPDATE on summary_cache';
  END IF;

  -- ingest role MUST have INSERT on health_samples
  IF NOT has_table_privilege('health_ingest_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'health_ingest_role missing INSERT on health_samples';
  END IF;

  RAISE NOTICE 'roles.test.sql OK';
END $$;
```

- [ ] **Step 2: Run the test against the current schema (post-1.1) and confirm it fails**

```bash
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/roles.test.sql
```

Expected: `ERROR: health_ingest_role missing`.

- [ ] **Step 3: Write the roles migration**

Create `supabase/migrations/20260507000100_roles.sql`:

```sql
-- Two non-login roles. Login is granted to per-environment users
-- (via deploy/.env) which inherit from these.

CREATE ROLE health_ingest_role NOLOGIN;
CREATE ROLE health_read_role   NOLOGIN;

-- Ingest role: writes to data tables, can flip cache invalidated flag.
GRANT INSERT, UPDATE ON health_samples TO health_ingest_role;
GRANT INSERT, UPDATE ON device_state   TO health_ingest_role;
GRANT UPDATE          ON summary_cache  TO health_ingest_role;
-- needs SELECT to support ON CONFLICT … DO UPDATE and to find affected cache rows
GRANT SELECT          ON health_samples TO health_ingest_role;
GRANT SELECT          ON device_state   TO health_ingest_role;
GRANT SELECT          ON summary_cache  TO health_ingest_role;
GRANT USAGE, SELECT   ON ALL SEQUENCES IN SCHEMA public TO health_ingest_role;

-- Read role: SELECT on data tables, full DML on summary_cache only.
GRANT SELECT                            ON health_samples TO health_read_role;
GRANT SELECT                            ON device_state   TO health_read_role;
GRANT SELECT, INSERT, UPDATE, DELETE    ON summary_cache  TO health_read_role;
GRANT USAGE, SELECT                     ON ALL SEQUENCES IN SCHEMA public TO health_read_role;

-- Future tables/sequences in public schema inherit these grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO health_read_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO health_ingest_role;
```

- [ ] **Step 4: Apply and re-run the test**

```bash
supabase db reset
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/schema.test.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/roles.test.sql
```

Expected: both print `... OK` and exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260507000100_roles.sql supabase/tests/roles.test.sql
git commit -m "feat(db): add health_ingest_role and health_read_role"
```

---

### Task 1.3: Metrics views

**Files:**
- Create: `supabase/migrations/20260507000200_metrics_views.sql`
- Create: `supabase/tests/metrics_views.test.sql`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/metrics_views.test.sql`:

```sql
-- Insert deterministic samples and check the views aggregate them correctly.
TRUNCATE health_samples;

INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date, source_name)
VALUES
  ('a1', 'quantity', 'HKQuantityTypeIdentifierStepCount',     3000, 'count', '2026-04-01T08:00:00Z', '2026-04-01T08:30:00Z', 'iPhone'),
  ('a2', 'quantity', 'HKQuantityTypeIdentifierStepCount',     5000, 'count', '2026-04-01T18:00:00Z', '2026-04-01T18:30:00Z', 'iPhone'),
  ('a3', 'quantity', 'HKQuantityTypeIdentifierHeartRate',       70, 'count/min', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z', 'Watch'),
  ('a4', 'quantity', 'HKQuantityTypeIdentifierHeartRate',       80, 'count/min', '2026-04-01T11:00:00Z', '2026-04-01T11:00:00Z', 'Watch');

DO $$
DECLARE
  total_steps NUMERIC;
  avg_hr      NUMERIC;
BEGIN
  SELECT total_steps INTO total_steps
    FROM daily_metrics('UTC')
   WHERE day = DATE '2026-04-01';
  IF total_steps IS DISTINCT FROM 8000 THEN
    RAISE EXCEPTION 'expected 8000 steps, got %', total_steps;
  END IF;

  SELECT avg_heart_rate INTO avg_hr
    FROM daily_metrics('UTC')
   WHERE day = DATE '2026-04-01';
  IF round(avg_hr) IS DISTINCT FROM 75 THEN
    RAISE EXCEPTION 'expected avg HR 75, got %', avg_hr;
  END IF;

  RAISE NOTICE 'metrics_views.test.sql OK';
END $$;

TRUNCATE health_samples;
```

- [ ] **Step 2: Run it; expect failure (the views don't exist yet)**

```bash
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/metrics_views.test.sql
```

Expected: `ERROR: function daily_metrics(unknown) does not exist`.

- [ ] **Step 3: Write the migration with the three set-returning functions**

Create `supabase/migrations/20260507000200_metrics_views.sql`:

```sql
-- Per-day aggregated metrics, tz-aware.
-- Returns one row per day in the date range covered by samples.
CREATE OR REPLACE FUNCTION daily_metrics(p_tz TEXT)
RETURNS TABLE (
  day                DATE,
  total_steps        NUMERIC,
  avg_heart_rate     NUMERIC,
  resting_heart_rate NUMERIC,
  hrv_mean           NUMERIC,
  sleep_minutes      NUMERIC,
  workout_count      INTEGER
) LANGUAGE sql STABLE AS $$
  WITH bucketed AS (
    SELECT
      (start_date AT TIME ZONE p_tz)::date AS day,
      data_type,
      value,
      sample_kind,
      end_date - start_date AS duration
    FROM health_samples
    WHERE deleted_at IS NULL
  )
  SELECT
    day,
    SUM(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierStepCount')                              AS total_steps,
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRate')                              AS avg_heart_rate,
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierRestingHeartRate')                       AS resting_heart_rate,
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN')               AS hrv_mean,
    SUM(EXTRACT(EPOCH FROM duration) / 60) FILTER (WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis') AS sleep_minutes,
    COUNT(*) FILTER (WHERE sample_kind = 'workout')::int                                                   AS workout_count
  FROM bucketed
  GROUP BY day
  ORDER BY day;
$$;

CREATE OR REPLACE FUNCTION weekly_metrics(p_tz TEXT)
RETURNS TABLE (
  week_start         DATE,
  total_steps        NUMERIC,
  avg_heart_rate     NUMERIC,
  resting_heart_rate NUMERIC,
  hrv_mean           NUMERIC,
  sleep_minutes      NUMERIC,
  workout_count      INTEGER
) LANGUAGE sql STABLE AS $$
  WITH bucketed AS (
    SELECT
      date_trunc('week', start_date AT TIME ZONE p_tz)::date AS week_start,
      data_type,
      value,
      sample_kind,
      end_date - start_date AS duration
    FROM health_samples
    WHERE deleted_at IS NULL
  )
  SELECT
    week_start,
    SUM(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierStepCount'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRate'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierRestingHeartRate'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN'),
    SUM(EXTRACT(EPOCH FROM duration) / 60) FILTER (WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'),
    COUNT(*) FILTER (WHERE sample_kind = 'workout')::int
  FROM bucketed
  GROUP BY week_start
  ORDER BY week_start;
$$;

CREATE OR REPLACE FUNCTION monthly_metrics(p_tz TEXT)
RETURNS TABLE (
  month_start        DATE,
  total_steps        NUMERIC,
  avg_heart_rate     NUMERIC,
  resting_heart_rate NUMERIC,
  hrv_mean           NUMERIC,
  sleep_minutes      NUMERIC,
  workout_count      INTEGER
) LANGUAGE sql STABLE AS $$
  WITH bucketed AS (
    SELECT
      date_trunc('month', start_date AT TIME ZONE p_tz)::date AS month_start,
      data_type,
      value,
      sample_kind,
      end_date - start_date AS duration
    FROM health_samples
    WHERE deleted_at IS NULL
  )
  SELECT
    month_start,
    SUM(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierStepCount'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRate'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierRestingHeartRate'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN'),
    SUM(EXTRACT(EPOCH FROM duration) / 60) FILTER (WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'),
    COUNT(*) FILTER (WHERE sample_kind = 'workout')::int
  FROM bucketed
  GROUP BY month_start
  ORDER BY month_start;
$$;

GRANT EXECUTE ON FUNCTION daily_metrics(TEXT)   TO health_read_role, health_ingest_role;
GRANT EXECUTE ON FUNCTION weekly_metrics(TEXT)  TO health_read_role, health_ingest_role;
GRANT EXECUTE ON FUNCTION monthly_metrics(TEXT) TO health_read_role, health_ingest_role;
```

- [ ] **Step 4: Apply, re-run test**

```bash
supabase db reset
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/metrics_views.test.sql
```

Expected: `NOTICE: metrics_views.test.sql OK`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260507000200_metrics_views.sql supabase/tests/metrics_views.test.sql
git commit -m "feat(db): add daily/weekly/monthly metrics functions"
```

---

### Task 1.4: `data_completeness` function

**Files:**
- Create: `supabase/migrations/20260507000300_data_completeness.sql`
- Create: `supabase/tests/data_completeness.test.sql`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/data_completeness.test.sql`:

```sql
TRUNCATE health_samples;

INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
VALUES
  ('c1', 'quantity', 'HKQuantityTypeIdentifierStepCount',     1, 'count', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z'),
  ('c2', 'quantity', 'HKQuantityTypeIdentifierStepCount',     1, 'count', '2026-04-03T10:00:00Z', '2026-04-03T10:00:00Z');

DO $$
DECLARE
  rec RECORD;
  found_gap BOOLEAN := false;
BEGIN
  FOR rec IN
    SELECT * FROM data_completeness(
      '2026-04-01T00:00:00Z'::timestamptz,
      '2026-04-04T00:00:00Z'::timestamptz,
      'UTC'
    )
  LOOP
    IF rec.day = DATE '2026-04-02' AND rec.data_type = 'HKQuantityTypeIdentifierStepCount' AND rec.sample_count = 0 THEN
      found_gap := true;
    END IF;
  END LOOP;
  IF NOT found_gap THEN
    RAISE EXCEPTION 'expected gap on 2026-04-02 for StepCount, but found none';
  END IF;
  RAISE NOTICE 'data_completeness.test.sql OK';
END $$;

TRUNCATE health_samples;
```

- [ ] **Step 2: Run; expect failure**

```bash
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/data_completeness.test.sql
```

Expected: `ERROR: function data_completeness(...) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260507000300_data_completeness.sql`:

```sql
-- For each (day, data_type) pair in the requested range, returns the sample count.
-- Days with zero samples for an expected data_type appear as sample_count = 0.
CREATE OR REPLACE FUNCTION data_completeness(
  p_start TIMESTAMPTZ,
  p_end   TIMESTAMPTZ,
  p_tz    TEXT
) RETURNS TABLE (
  day          DATE,
  data_type    TEXT,
  sample_count BIGINT
) LANGUAGE sql STABLE AS $$
  WITH days AS (
    SELECT generate_series(
      (p_start AT TIME ZONE p_tz)::date,
      (p_end   AT TIME ZONE p_tz)::date,
      INTERVAL '1 day'
    )::date AS day
  ),
  expected_types AS (
    SELECT unnest(ARRAY[
      'HKQuantityTypeIdentifierStepCount',
      'HKQuantityTypeIdentifierHeartRate',
      'HKQuantityTypeIdentifierRestingHeartRate',
      'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
      'HKCategoryTypeIdentifierSleepAnalysis'
    ]) AS data_type
  ),
  grid AS (
    SELECT d.day, t.data_type
    FROM days d CROSS JOIN expected_types t
  ),
  counts AS (
    SELECT
      (start_date AT TIME ZONE p_tz)::date AS day,
      data_type,
      COUNT(*) AS sample_count
    FROM health_samples
    WHERE deleted_at IS NULL
      AND start_date >= p_start
      AND start_date <  p_end
    GROUP BY (start_date AT TIME ZONE p_tz)::date, data_type
  )
  SELECT g.day, g.data_type, COALESCE(c.sample_count, 0) AS sample_count
  FROM grid g
  LEFT JOIN counts c USING (day, data_type)
  ORDER BY g.day, g.data_type;
$$;

GRANT EXECUTE ON FUNCTION data_completeness(TIMESTAMPTZ, TIMESTAMPTZ, TEXT)
  TO health_read_role, health_ingest_role;
```

- [ ] **Step 4: Apply, re-run**

```bash
supabase db reset
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/data_completeness.test.sql
```

Expected: `NOTICE: data_completeness.test.sql OK`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260507000300_data_completeness.sql supabase/tests/data_completeness.test.sql
git commit -m "feat(db): add data_completeness function"
```

---

### Task 1.5: `detect_anomalies` function

The legacy heuristics are in `_legacy/src/tools/anomalies.ts`. The thresholds we port:
- HRV decline: 7-day mean is more than 15% below 30-day baseline.
- Sleep deficit: 3 consecutive nights with <360 minutes (6h).
- Resting HR spike: any day with resting HR more than 5 bpm above 14-day baseline.
- Low step day: any day in the window with steps < 3000.

**Files:**
- Create: `supabase/migrations/20260507000400_detect_anomalies.sql`
- Create: `supabase/tests/detect_anomalies.test.sql`

- [ ] **Step 1: Write the failing test**

Create `supabase/tests/detect_anomalies.test.sql`:

```sql
TRUNCATE health_samples;

-- Seed: 30 days of healthy data, then 3 nights of bad sleep at the end.
INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
SELECT
  'sleep-' || i,
  'category',
  'HKCategoryTypeIdentifierSleepAnalysis',
  1,
  NULL,
  ('2026-04-01T22:00:00Z'::timestamptz + (i || ' days')::interval),
  ('2026-04-02T05:00:00Z'::timestamptz + (i || ' days')::interval)
FROM generate_series(0, 29) i;

-- Last 3 nights only 4 hours.
UPDATE health_samples
   SET end_date = start_date + INTERVAL '4 hours'
 WHERE uuid IN ('sleep-27', 'sleep-28', 'sleep-29');

DO $$
DECLARE
  found BOOLEAN := false;
  rec   RECORD;
BEGIN
  FOR rec IN SELECT * FROM detect_anomalies(30) LOOP
    IF rec.kind = 'sleep_deficit' THEN
      found := true;
    END IF;
  END LOOP;
  IF NOT found THEN
    RAISE EXCEPTION 'expected sleep_deficit anomaly, got none';
  END IF;
  RAISE NOTICE 'detect_anomalies.test.sql OK';
END $$;

TRUNCATE health_samples;
```

- [ ] **Step 2: Run; expect failure**

```bash
psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
     -f supabase/tests/detect_anomalies.test.sql
```

Expected: `ERROR: function detect_anomalies(integer) does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260507000400_detect_anomalies.sql`:

```sql
-- Returns a set of detected anomalies in the trailing window_days days.
-- kind     : machine-readable identifier (sleep_deficit, hrv_decline, hr_spike, low_step_day)
-- severity : 'info' | 'warn' | 'alert'
-- detail   : human-readable description
-- ref_date : the date the anomaly is anchored to (for grouping/sorting)
CREATE OR REPLACE FUNCTION detect_anomalies(p_window_days INT)
RETURNS TABLE (
  kind     TEXT,
  severity TEXT,
  detail   TEXT,
  ref_date DATE
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_now    TIMESTAMPTZ := now();
  v_start  TIMESTAMPTZ := now() - (p_window_days || ' days')::interval;
BEGIN
  -- 1. Sleep deficit: 3 consecutive nights < 360 minutes
  RETURN QUERY
    WITH nightly AS (
      SELECT
        (start_date AT TIME ZONE 'UTC')::date AS night,
        SUM(EXTRACT(EPOCH FROM (end_date - start_date)) / 60) AS minutes
      FROM health_samples
      WHERE deleted_at IS NULL
        AND data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
        AND start_date >= v_start
      GROUP BY 1
    ),
    flagged AS (
      SELECT night, minutes,
             COUNT(*) FILTER (WHERE minutes < 360) OVER (
               ORDER BY night ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
             ) AS deficit_run
      FROM nightly
    )
    SELECT 'sleep_deficit'::TEXT,
           'warn'::TEXT,
           ('3 consecutive nights of <6h sleep ending ' || night)::TEXT,
           night
    FROM flagged WHERE deficit_run = 3;

  -- 2. HRV decline: 7-day mean < 0.85 * 30-day mean
  RETURN QUERY
    WITH daily_hrv AS (
      SELECT (start_date AT TIME ZONE 'UTC')::date AS day,
             AVG(value) AS hrv
      FROM health_samples
      WHERE deleted_at IS NULL
        AND data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN'
        AND start_date >= v_now - INTERVAL '30 days'
      GROUP BY 1
    ),
    avgs AS (
      SELECT
        AVG(hrv) FILTER (WHERE day >= (v_now - INTERVAL '7 days')::date)  AS recent,
        AVG(hrv)                                                          AS baseline,
        MAX(day)                                                          AS latest_day
      FROM daily_hrv
    )
    SELECT 'hrv_decline'::TEXT,
           'alert'::TEXT,
           ('7d HRV ' || ROUND(recent::numeric, 1) || ' is ' ||
             ROUND((100 * (1 - recent / baseline))::numeric, 1) ||
             '% below 30d baseline ' || ROUND(baseline::numeric, 1))::TEXT,
           latest_day
    FROM avgs
    WHERE recent IS NOT NULL AND baseline IS NOT NULL AND recent < 0.85 * baseline;

  -- 3. Resting HR spike: any day in window with rHR > 14d baseline + 5
  RETURN QUERY
    WITH daily_rhr AS (
      SELECT (start_date AT TIME ZONE 'UTC')::date AS day,
             AVG(value) AS rhr
      FROM health_samples
      WHERE deleted_at IS NULL
        AND data_type = 'HKQuantityTypeIdentifierRestingHeartRate'
        AND start_date >= v_now - INTERVAL '14 days'
      GROUP BY 1
    ),
    baseline AS (SELECT AVG(rhr) AS rhr FROM daily_rhr)
    SELECT 'hr_spike'::TEXT,
           'warn'::TEXT,
           ('Resting HR ' || ROUND(d.rhr::numeric, 0) || ' on ' || d.day ||
             ' (>5 bpm above 14d baseline ' || ROUND(b.rhr::numeric, 0) || ')')::TEXT,
           d.day
    FROM daily_rhr d, baseline b
    WHERE d.day >= v_start::date
      AND d.rhr > b.rhr + 5;

  -- 4. Low-step day: any day in window with steps < 3000
  RETURN QUERY
    SELECT 'low_step_day'::TEXT,
           'info'::TEXT,
           ('Only ' || ROUND(SUM(value)::numeric, 0) || ' steps on ' ||
             (start_date AT TIME ZONE 'UTC')::date)::TEXT,
           (start_date AT TIME ZONE 'UTC')::date
    FROM health_samples
    WHERE deleted_at IS NULL
      AND data_type = 'HKQuantityTypeIdentifierStepCount'
      AND start_date >= v_start
    GROUP BY (start_date AT TIME ZONE 'UTC')::date, start_date
    HAVING SUM(value) < 3000;
END $$;

GRANT EXECUTE ON FUNCTION detect_anomalies(INT) TO health_read_role, health_ingest_role;
```

- [ ] **Step 4: Apply and run all schema tests**

```bash
supabase db reset
for t in supabase/tests/*.test.sql; do
  psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -f "$t" || exit 1
done
```

Expected: every test prints `... OK`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260507000400_detect_anomalies.sql supabase/tests/detect_anomalies.test.sql
git commit -m "feat(db): add detect_anomalies function"
```

---

## Phase 2 — Ingest Edge Function

The Edge Function lives at `supabase/functions/ingest/`. It validates a bearer token, validates the body, performs all writes against Postgres as `health_ingest_role`, and returns `{ stored, deleted }`. Tests run with `deno test` against the local Supabase Postgres.

The function decomposes into:
- `auth.ts` — bearer comparison.
- `schema.ts` — Zod-style schemas (use `npm:zod` from Deno).
- `db.ts` — postgres-js client factory.
- `handler.ts` — pure logic taking `(sql, payload)`.
- `index.ts` — HTTP entry.

### Task 2.1: Edge Function scaffolding

**Files:**
- Create: `supabase/functions/ingest/index.ts` (placeholder)
- Create: `supabase/functions/ingest/deno.json`
- Create: `supabase/functions/ingest/.env.example`

- [ ] **Step 1: Create the function via the CLI**

```bash
cd supabase
supabase functions new ingest
cd ..
```

This creates `supabase/functions/ingest/index.ts` with a hello-world handler.

- [ ] **Step 2: Replace `index.ts` with a placeholder that compiles**

```typescript
import 'https://deno.land/std@0.224.0/dotenv/load.ts';

Deno.serve((_req) => {
  return new Response(JSON.stringify({ error: { code: 'not_implemented', message: 'wire up later' } }), {
    status: 501,
    headers: { 'content-type': 'application/json' }
  });
});
```

- [ ] **Step 3: Verify the function deploys locally**

```bash
cd supabase
supabase functions serve ingest --no-verify-jwt &
SERVE_PID=$!
sleep 2
curl -sS -X POST http://127.0.0.1:54321/functions/v1/ingest -d '{}'
kill $SERVE_PID
cd ..
```

Expected: response body `{"error":{"code":"not_implemented","message":"wire up later"}}` with HTTP 501.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/ingest/
git commit -m "chore(ingest): scaffold edge function"
```

---

### Task 2.2: Auth helper with timing-safe comparison

**Files:**
- Create: `supabase/functions/ingest/auth.ts`
- Create: `supabase/functions/ingest/auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/ingest/auth.test.ts`:

```typescript
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { checkBearer } from './auth.ts';

Deno.test('checkBearer accepts the configured token', () => {
  Deno.env.set('INGEST_API_KEY', 'secret-token-123');
  const headers = new Headers({ authorization: 'Bearer secret-token-123' });
  assert(checkBearer(headers));
});

Deno.test('checkBearer rejects a bad token', () => {
  Deno.env.set('INGEST_API_KEY', 'secret-token-123');
  const headers = new Headers({ authorization: 'Bearer wrong' });
  assertEquals(checkBearer(headers), false);
});

Deno.test('checkBearer rejects when header missing', () => {
  Deno.env.set('INGEST_API_KEY', 'secret-token-123');
  const headers = new Headers({});
  assertEquals(checkBearer(headers), false);
});

Deno.test('checkBearer rejects when env missing', () => {
  Deno.env.delete('INGEST_API_KEY');
  const headers = new Headers({ authorization: 'Bearer anything' });
  assertEquals(checkBearer(headers), false);
});
```

- [ ] **Step 2: Run the test; expect compile failure**

```bash
cd supabase/functions/ingest
deno test --allow-env auth.test.ts
cd ../../..
```

Expected: error like `Module not found "file://.../auth.ts"`.

- [ ] **Step 3: Implement `auth.ts`**

```typescript
import { timingSafeEqual } from 'https://deno.land/std@0.224.0/crypto/timing_safe_equal.ts';

export function checkBearer(headers: Headers): boolean {
  const expected = Deno.env.get('INGEST_API_KEY');
  if (!expected) return false;

  const authz = headers.get('authorization');
  if (!authz || !authz.startsWith('Bearer ')) return false;

  const provided = authz.slice('Bearer '.length);

  // Pad to constant length to avoid leaking length.
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}
```

- [ ] **Step 4: Re-run test**

```bash
cd supabase/functions/ingest
deno test --allow-env auth.test.ts
cd ../../..
```

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ingest/auth.ts supabase/functions/ingest/auth.test.ts
git commit -m "feat(ingest): add timing-safe bearer auth"
```

---

### Task 2.3: Body schema with Zod

**Files:**
- Create: `supabase/functions/ingest/schema.ts`
- Create: `supabase/functions/ingest/schema.test.ts`

- [ ] **Step 1: Write the failing test**

Create `supabase/functions/ingest/schema.test.ts`:

```typescript
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { IngestPayloadSchema } from './schema.ts';

Deno.test('parses a minimal valid payload', () => {
  const result = IngestPayloadSchema.safeParse({
    device_id: 'dev1',
    new_samples: [{
      uuid: 'u1',
      sample_kind: 'quantity',
      data_type: 'HKQuantityTypeIdentifierStepCount',
      value: 100,
      unit: 'count',
      start_date: '2026-04-01T10:00:00Z',
      end_date:   '2026-04-01T10:00:00Z',
      source_name: 'iPhone'
    }],
    deleted_ids: []
  });
  assert(result.success, JSON.stringify(result));
});

Deno.test('rejects an invalid sample_kind', () => {
  const result = IngestPayloadSchema.safeParse({
    device_id: 'dev1',
    new_samples: [{
      uuid: 'u1',
      sample_kind: 'bogus',
      data_type: 'HKX',
      value: 1,
      unit: 'x',
      start_date: '2026-04-01T10:00:00Z',
      end_date:   '2026-04-01T10:00:00Z',
      source_name: 'iPhone'
    }],
    deleted_ids: []
  });
  assertEquals(result.success, false);
});

Deno.test('rejects a non-ISO date', () => {
  const result = IngestPayloadSchema.safeParse({
    device_id: 'dev1',
    new_samples: [{
      uuid: 'u1',
      sample_kind: 'quantity',
      data_type: 'HKX',
      value: 1,
      unit: 'x',
      start_date: 'not-a-date',
      end_date:   '2026-04-01T10:00:00Z',
      source_name: 'iPhone'
    }],
    deleted_ids: []
  });
  assertEquals(result.success, false);
});
```

- [ ] **Step 2: Run; expect compile failure**

```bash
cd supabase/functions/ingest
deno test --allow-env schema.test.ts
cd ../../..
```

Expected: `Module not found "file://.../schema.ts"`.

- [ ] **Step 3: Implement `schema.ts`**

```typescript
import { z } from 'npm:zod@3.23.8';

const IsoDate = z.string().refine(
  (s) => !Number.isNaN(Date.parse(s)),
  { message: 'not a valid ISO date' }
);

export const SampleSchema = z.object({
  uuid:        z.string().min(1),
  sample_kind: z.enum(['quantity', 'category', 'workout']),
  data_type:   z.string().min(1),
  value:       z.number().nullable().optional(),
  unit:        z.string().nullable().optional(),
  start_date:  IsoDate,
  end_date:    IsoDate,
  source_name: z.string().nullable().optional(),
  metadata:    z.record(z.unknown()).nullable().optional()
});

export const IngestPayloadSchema = z.object({
  device_id:    z.string().min(1),
  new_samples:  z.array(SampleSchema),
  deleted_ids:  z.array(z.string().min(1))
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
export type Sample        = z.infer<typeof SampleSchema>;
```

- [ ] **Step 4: Re-run**

```bash
cd supabase/functions/ingest
deno test --allow-env schema.test.ts
cd ../../..
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/ingest/schema.ts supabase/functions/ingest/schema.test.ts
git commit -m "feat(ingest): add zod payload schema"
```

---

### Task 2.4: DB client + handler with upsert and soft-delete

**Files:**
- Create: `supabase/functions/ingest/db.ts`
- Create: `supabase/functions/ingest/handler.ts`
- Create: `supabase/functions/ingest/handler.test.ts`

- [ ] **Step 1: Add a local seed user that the test connects as**

The Supabase CLI runs `supabase/seed.sql` automatically after applying migrations during `supabase db reset`. Use it to create login users that inherit from the two roles (this is local-dev only — production users are created in deploy/init-users.sh in Phase 4).

Create `supabase/seed.sql`:

```sql
-- Local-dev: a real login user that inherits from the ingest role,
-- so deno tests can connect with a known DSN.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingest_user') THEN
    CREATE ROLE ingest_user LOGIN PASSWORD 'ingest_pw' IN ROLE health_ingest_role;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_user') THEN
    CREATE ROLE read_user LOGIN PASSWORD 'read_pw' IN ROLE health_read_role;
  END IF;
END $$;
```

Verify: `supabase db reset` then `psql 'postgresql://ingest_user:ingest_pw@127.0.0.1:54322/postgres' -c 'select 1'` should print `1`.

- [ ] **Step 2: Write the failing handler test**

Create `supabase/functions/ingest/handler.test.ts`:

```typescript
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import postgres from 'npm:postgres@3.4.4';
import { handleIngest } from './handler.ts';

const DSN = 'postgresql://ingest_user:ingest_pw@127.0.0.1:54322/postgres';

async function withSql(fn: (sql: ReturnType<typeof postgres>) => Promise<void>) {
  const sql = postgres(DSN, { max: 2 });
  try {
    await sql`TRUNCATE health_samples, device_state, summary_cache`;
    await fn(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

Deno.test('inserts new samples', async () => {
  await withSql(async (sql) => {
    const result = await handleIngest(sql, {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'u1',
        sample_kind: 'quantity',
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 100,
        unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    });
    assertEquals(result.stored, 1);
    assertEquals(result.deleted, 0);

    const rows = await sql`SELECT count(*)::int AS n FROM health_samples`;
    assertEquals(rows[0].n, 1);
  });
});

Deno.test('upsert is idempotent', async () => {
  await withSql(async (sql) => {
    const payload = {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'u1', sample_kind: 'quantity' as const,
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 100, unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    };
    await handleIngest(sql, payload);
    await handleIngest(sql, payload);

    const rows = await sql`SELECT count(*)::int AS n FROM health_samples`;
    assertEquals(rows[0].n, 1);
  });
});

Deno.test('soft-deletes by uuid', async () => {
  await withSql(async (sql) => {
    await handleIngest(sql, {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'u1', sample_kind: 'quantity',
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 100, unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    });

    const result = await handleIngest(sql, {
      device_id: 'dev1',
      new_samples: [],
      deleted_ids: ['u1']
    });
    assertEquals(result.deleted, 1);

    const rows = await sql`SELECT deleted_at FROM health_samples WHERE uuid = 'u1'`;
    assertEquals(rows[0].deleted_at !== null, true);
  });
});

Deno.test('updates device_state', async () => {
  await withSql(async (sql) => {
    await handleIngest(sql, {
      device_id: 'devXYZ',
      new_samples: [],
      deleted_ids: []
    });
    const rows = await sql`SELECT * FROM device_state WHERE device_id = 'devXYZ'`;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].last_synced_at !== null, true);
  });
});

Deno.test('marks summary_cache rows for affected dates as invalidated', async () => {
  await withSql(async (sql) => {
    await sql`INSERT INTO summary_cache (cache_key, markdown) VALUES ('daily:2026-04-01:UTC', 'old'), ('daily:2026-05-01:UTC', 'untouched')`;
    await handleIngest(sql, {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'u1', sample_kind: 'quantity',
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 100, unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    });
    const touched = await sql`SELECT cache_key, invalidated FROM summary_cache ORDER BY cache_key`;
    assertEquals(touched[0].cache_key, 'daily:2026-04-01:UTC');
    assertEquals(touched[0].invalidated, true);
    assertEquals(touched[1].cache_key, 'daily:2026-05-01:UTC');
    assertEquals(touched[1].invalidated, false);
  });
});
```

- [ ] **Step 3: Run the test; expect failure**

```bash
cd supabase
supabase db reset
cd functions/ingest
deno test --allow-env --allow-net --allow-read handler.test.ts
cd ../../..
```

Expected: `Module not found "file://.../handler.ts"`.

- [ ] **Step 4: Implement `db.ts` and `handler.ts`**

`supabase/functions/ingest/db.ts`:

```typescript
import postgres from 'npm:postgres@3.4.4';

export type Sql = ReturnType<typeof postgres>;

export function makeSql(): Sql {
  const dsn = Deno.env.get('INGEST_DATABASE_URL');
  if (!dsn) throw new Error('INGEST_DATABASE_URL is not set');
  return postgres(dsn, { max: 4, prepare: false });
}
```

`supabase/functions/ingest/handler.ts`:

```typescript
import type { Sql } from './db.ts';
import type { IngestPayload, Sample } from './schema.ts';

export interface IngestResult {
  stored:  number;
  deleted: number;
}

export async function handleIngest(sql: Sql, payload: IngestPayload): Promise<IngestResult> {
  const { device_id, new_samples, deleted_ids } = payload;

  let stored = 0;
  let deleted = 0;
  const touchedDays = new Set<string>();

  await sql.begin(async (tx) => {
    if (new_samples.length > 0) {
      const rows = new_samples.map((s: Sample) => ({
        uuid:        s.uuid,
        sample_kind: s.sample_kind,
        data_type:   s.data_type,
        value:       s.value ?? null,
        unit:        s.unit ?? null,
        start_date:  s.start_date,
        end_date:    s.end_date,
        source_name: s.source_name ?? null,
        metadata:    s.metadata ?? null,
        device_id:   device_id
      }));

      const result = await tx`
        INSERT INTO health_samples ${ tx(rows, 'uuid', 'sample_kind', 'data_type', 'value', 'unit', 'start_date', 'end_date', 'source_name', 'metadata', 'device_id') }
        ON CONFLICT (uuid) DO UPDATE SET
          value       = EXCLUDED.value,
          unit        = EXCLUDED.unit,
          start_date  = EXCLUDED.start_date,
          end_date    = EXCLUDED.end_date,
          source_name = EXCLUDED.source_name,
          metadata    = EXCLUDED.metadata,
          deleted_at  = NULL
      `;
      stored = result.count;

      for (const s of new_samples) {
        const day = s.start_date.slice(0, 10);
        touchedDays.add(day);
      }
    }

    if (deleted_ids.length > 0) {
      const result = await tx`
        UPDATE health_samples
           SET deleted_at = now()
         WHERE uuid = ANY(${deleted_ids})
           AND deleted_at IS NULL
      `;
      deleted = result.count;
    }

    if (touchedDays.size > 0) {
      const days = Array.from(touchedDays);
      await tx`
        UPDATE summary_cache
           SET invalidated = true
         WHERE cache_key LIKE ANY(${days.map((d) => `daily:${d}:%`)})
            OR cache_key LIKE ANY(${days.map((d) => `weekly:${d.slice(0, 7)}%:%`)})
            OR cache_key LIKE ANY(${days.map((d) => `monthly:${d.slice(0, 7)}:%`)})
      `;
    }

    await tx`
      INSERT INTO device_state (device_id, last_synced_at, last_anchor)
      VALUES (${device_id}, now(), null)
      ON CONFLICT (device_id) DO UPDATE SET
        last_synced_at = EXCLUDED.last_synced_at
    `;
  });

  return { stored, deleted };
}
```

- [ ] **Step 5: Re-run the test**

```bash
cd supabase/functions/ingest
deno test --allow-env --allow-net --allow-read handler.test.ts
cd ../../..
```

Expected: 5 tests pass.

- [ ] **Step 6: Commit**

```bash
git add supabase/seed.sql supabase/functions/ingest/db.ts supabase/functions/ingest/handler.ts supabase/functions/ingest/handler.test.ts
git commit -m "feat(ingest): add postgres-js client and handler with upsert/soft-delete/cache-invalidation"
```

---

### Task 2.5: HTTP entry — wire it together

**Files:**
- Modify: `supabase/functions/ingest/index.ts` (full rewrite)
- Create: `supabase/functions/ingest/index.test.ts`

- [ ] **Step 1: Write the failing integration test**

Create `supabase/functions/ingest/index.test.ts`:

```typescript
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const URL = 'http://127.0.0.1:54321/functions/v1/ingest';
const KEY = 'test-ingest-key';

Deno.test({
  name: 'POST /ingest returns 401 without auth',
  ignore: !Deno.env.get('RUN_INTEGRATION'),
  async fn() {
    const r = await fetch(URL, { method: 'POST', body: '{}' });
    assertEquals(r.status, 401);
    await r.body?.cancel();
  }
});

Deno.test({
  name: 'POST /ingest returns 400 on bad body',
  ignore: !Deno.env.get('RUN_INTEGRATION'),
  async fn() {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: '{}'
    });
    assertEquals(r.status, 400);
    await r.body?.cancel();
  }
});

Deno.test({
  name: 'POST /ingest stores a sample and returns counts',
  ignore: !Deno.env.get('RUN_INTEGRATION'),
  async fn() {
    const body = {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'integration-1',
        sample_kind: 'quantity',
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 200,
        unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    };
    const r = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assertEquals(r.status, 200);
    const json = await r.json();
    assertEquals(json, { stored: 1, deleted: 0 });
  }
});
```

- [ ] **Step 2: Implement `index.ts`**

Replace `supabase/functions/ingest/index.ts`:

```typescript
import { checkBearer } from './auth.ts';
import { IngestPayloadSchema } from './schema.ts';
import { makeSql } from './db.ts';
import { handleIngest } from './handler.ts';

const sql = makeSql();

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonError(405, 'method_not_allowed', 'POST only');
  if (!checkBearer(req.headers)) return jsonError(401, 'unauthorized', 'invalid bearer');

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return jsonError(400, 'invalid_json', 'body is not valid JSON');
  }

  const parsed = IngestPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_payload', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  try {
    const result = await handleIngest(sql, parsed.data);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    console.error('ingest failed:', e);
    return jsonError(500, 'server_error', 'unexpected error');
  }
});
```

- [ ] **Step 3: Run the integration tests**

```bash
cd supabase
supabase db reset
INGEST_API_KEY=test-ingest-key INGEST_DATABASE_URL='postgresql://ingest_user:ingest_pw@127.0.0.1:54322/postgres' \
  supabase functions serve ingest --no-verify-jwt &
SERVE_PID=$!
sleep 3
cd functions/ingest
RUN_INTEGRATION=1 deno test --allow-env --allow-net --allow-read index.test.ts
cd ../../..
kill $SERVE_PID
```

Expected: 3 tests pass.

- [ ] **Step 4: Commit**

```bash
git add supabase/functions/ingest/index.ts supabase/functions/ingest/index.test.ts
git commit -m "feat(ingest): wire HTTP handler with auth, validation, error mapping"
```

---

## Phase 3 — MCP Server

The MCP server lives at `mcp-server/`. Tests use Vitest with the local Supabase Postgres reachable at `127.0.0.1:54322`. Connection uses `read_user` (defined in seed.sql) which inherits from `health_read_role`.

### Task 3.1: DB pool module

**Files:**
- Create: `mcp-server/src/db.ts`
- Create: `mcp-server/src/db.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// mcp-server/src/db.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from './db.ts';

const DSN = process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54322/postgres';
const pool = createPool(DSN);

afterAll(async () => { await pool.end(); });

describe('db pool', () => {
  it('connects and runs a SELECT', async () => {
    const r = await pool.query<{ n: number }>('SELECT 1::int AS n');
    expect(r.rows[0].n).toBe(1);
  });

  it('rejects writes against health_samples', async () => {
    await expect(pool.query("INSERT INTO health_samples (uuid, sample_kind, data_type, start_date, end_date) VALUES ('x','quantity','y',now(),now())"))
      .rejects.toThrow(/permission denied/);
  });

  it('allows writes against summary_cache', async () => {
    await pool.query("INSERT INTO summary_cache (cache_key, markdown) VALUES ('test:1', 'hi') ON CONFLICT (cache_key) DO UPDATE SET markdown = EXCLUDED.markdown");
    await pool.query("DELETE FROM summary_cache WHERE cache_key = 'test:1'");
  });
});
```

- [ ] **Step 2: Run; expect compile failure**

```bash
cd mcp-server
npm test -- db.test.ts
cd ..
```

Expected: `Cannot find module './db.ts'`.

- [ ] **Step 3: Implement `db.ts`**

```typescript
// mcp-server/src/db.ts
import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(dsn: string): pg.Pool {
  return new pg.Pool({
    connectionString: dsn,
    max: 8,
    idleTimeoutMillis: 30_000
  });
}
```

- [ ] **Step 4: Re-run**

```bash
cd mcp-server
npm test -- db.test.ts
cd ..
```

Expected: 3 tests pass. (Make sure `supabase start` is running.)

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/db.ts mcp-server/src/db.test.ts
git commit -m "feat(mcp): add pg pool module"
```

---

### Task 3.2: Auth middleware

**Files:**
- Create: `mcp-server/src/auth.ts`
- Create: `mcp-server/src/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// mcp-server/src/auth.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { bearerAuth } from './auth.ts';

describe('bearerAuth middleware', () => {
  beforeEach(() => { process.env.MCP_API_KEY = 'mcp-secret'; });

  function buildApp() {
    const app = express();
    app.use(bearerAuth);
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    return app;
  }

  async function fetchOnce(app: express.Express, headers: Record<string, string>) {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, { headers });
      return { status: r.status };
    } finally {
      server.close();
    }
  }

  it('200 with correct token', async () => {
    const r = await fetchOnce(buildApp(), { authorization: 'Bearer mcp-secret' });
    expect(r.status).toBe(200);
  });

  it('401 with wrong token', async () => {
    const r = await fetchOnce(buildApp(), { authorization: 'Bearer wrong' });
    expect(r.status).toBe(401);
  });

  it('401 with missing header', async () => {
    const r = await fetchOnce(buildApp(), {});
    expect(r.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run; expect compile failure**

```bash
cd mcp-server
npm test -- auth.test.ts
cd ..
```

Expected: `Cannot find module './auth.ts'`.

- [ ] **Step 3: Implement `auth.ts`**

```typescript
// mcp-server/src/auth.ts
import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_API_KEY;
  if (!expected) {
    res.status(500).json({ error: 'MCP_API_KEY not configured' });
    return;
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const provided = header.slice('Bearer '.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
```

- [ ] **Step 4: Re-run**

```bash
cd mcp-server
npm test -- auth.test.ts
cd ..
```

Expected: 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/auth.ts mcp-server/src/auth.test.ts
git commit -m "feat(mcp): add bearer auth middleware"
```

---

### Task 3.3: `health_anomalies` tool

We do this before `health_summary` because it's strictly simpler.

**Files:**
- Create: `mcp-server/src/tools/health-anomalies.ts`
- Create: `mcp-server/src/tools/health-anomalies.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// mcp-server/src/tools/health-anomalies.test.ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../db.ts';
import { healthAnomalies } from './health-anomalies.ts';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54322/postgres');
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  // fixtures handled by the test below
});

describe('healthAnomalies', () => {
  it('returns markdown with no anomalies on empty DB', async () => {
    // we cannot truncate as read_user. Use an admin connection just for setup.
    const adminPool = createPool('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    await adminPool.query('TRUNCATE health_samples');
    await adminPool.end();

    const result = await healthAnomalies(pool, { window_days: 30 });
    expect(result).toMatch(/no anomalies/i);
  });

  it('reports a sleep_deficit anomaly', async () => {
    const adminPool = createPool('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
    await adminPool.query('TRUNCATE health_samples');
    for (let i = 0; i < 30; i++) {
      const start = new Date(`2026-04-01T22:00:00Z`);
      start.setUTCDate(start.getUTCDate() + i);
      const end = new Date(start);
      end.setUTCHours(end.getUTCHours() + (i >= 27 ? 4 : 7));
      await adminPool.query(
        `INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
         VALUES ($1, 'category', 'HKCategoryTypeIdentifierSleepAnalysis', 1, NULL, $2, $3)`,
        [`sleep-${i}`, start.toISOString(), end.toISOString()]
      );
    }
    await adminPool.end();

    const result = await healthAnomalies(pool, { window_days: 30 });
    expect(result).toMatch(/sleep_deficit/);
  });
});
```

- [ ] **Step 2: Run; expect failure**

```bash
cd mcp-server
npm test -- health-anomalies.test.ts
cd ..
```

Expected: `Cannot find module './health-anomalies.ts'`.

- [ ] **Step 3: Implement the tool**

```typescript
// mcp-server/src/tools/health-anomalies.ts
import type { Pool } from '../db.ts';

export interface HealthAnomaliesInput {
  window_days?: number;
}

interface AnomalyRow {
  kind: string;
  severity: string;
  detail: string;
  ref_date: Date;
}

const SEVERITY_ICON: Record<string, string> = { info: 'ℹ', warn: '⚠', alert: '🚨' };

export async function healthAnomalies(pool: Pool, input: HealthAnomaliesInput): Promise<string> {
  const window = Math.max(1, Math.min(180, input.window_days ?? 14));

  const r = await pool.query<AnomalyRow>(
    'SELECT kind, severity, detail, ref_date FROM detect_anomalies($1) ORDER BY ref_date DESC, severity',
    [window]
  );

  if (r.rows.length === 0) {
    return `# Health anomalies (last ${window} days)\n\n_No anomalies detected._`;
  }

  const lines = r.rows.map((row) => {
    const icon = SEVERITY_ICON[row.severity] ?? '•';
    const date = row.ref_date.toISOString().slice(0, 10);
    return `- ${icon} **${row.kind}** (${date}): ${row.detail}`;
  });

  return `# Health anomalies (last ${window} days)\n\n${lines.join('\n')}`;
}
```

- [ ] **Step 4: Re-run**

```bash
cd mcp-server
npm test -- health-anomalies.test.ts
cd ..
```

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/health-anomalies.ts mcp-server/src/tools/health-anomalies.test.ts
git commit -m "feat(mcp): add health_anomalies tool"
```

---

### Task 3.4: `run_sql` tool

**Files:**
- Create: `mcp-server/src/tools/run-sql.ts`
- Create: `mcp-server/src/tools/run-sql.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// mcp-server/src/tools/run-sql.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from '../db.ts';
import { runSql } from './run-sql.ts';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54322/postgres');
afterAll(async () => { await pool.end(); });

describe('runSql', () => {
  it('returns rows for a SELECT', async () => {
    const r = await runSql(pool, { query: 'SELECT 1::int AS n, \'hi\'::text AS msg' });
    expect(r.rows).toEqual([{ n: 1, msg: 'hi' }]);
  });

  it('rejects multi-statement queries', async () => {
    await expect(runSql(pool, { query: 'SELECT 1; SELECT 2' })).rejects.toThrow(/single statement/i);
  });

  it('surfaces postgres errors', async () => {
    await expect(runSql(pool, { query: 'SELECT * FROM nonexistent_table' })).rejects.toThrow(/does not exist/);
  });

  it('blocks writes against health_samples (role is read-only)', async () => {
    await expect(runSql(pool, {
      query: "INSERT INTO health_samples (uuid, sample_kind, data_type, start_date, end_date) VALUES ('x', 'quantity', 'y', now(), now())"
    })).rejects.toThrow(/permission denied/);
  });

  it('aborts on a slow query (statement timeout)', async () => {
    await expect(runSql(pool, { query: 'SELECT pg_sleep(10)' })).rejects.toThrow(/canceling statement|timeout/i);
  }, 10_000);
});
```

- [ ] **Step 2: Run; expect failure**

```bash
cd mcp-server
npm test -- run-sql.test.ts
cd ..
```

Expected: `Cannot find module './run-sql.ts'`.

- [ ] **Step 3: Implement the tool**

`SET LOCAL statement_timeout` only applies inside a transaction, and we want the timeout scoped to this client checkout, so wrap in `BEGIN READ ONLY` / `COMMIT`.

```typescript
// mcp-server/src/tools/run-sql.ts
import type { Pool } from '../db.ts';

export interface RunSqlInput {
  query: string;
}

export interface RunSqlResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

const STATEMENT_TIMEOUT_MS = 5_000;

export async function runSql(pool: Pool, input: RunSqlInput): Promise<RunSqlResult> {
  const trimmed = input.query.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    throw new Error('runSql accepts only a single statement');
  }
  if (trimmed.length === 0) {
    throw new Error('query is empty');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    try {
      const r = await client.query(trimmed);
      await client.query('COMMIT');
      return {
        rows: r.rows as Record<string, unknown>[],
        rowCount: r.rowCount ?? 0
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Re-run**

```bash
cd mcp-server
npm test -- run-sql.test.ts
cd ..
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/run-sql.ts mcp-server/src/tools/run-sql.test.ts
git commit -m "feat(mcp): add run_sql tool with timeout and single-statement enforcement"
```

---

### Task 3.5: `health_summary` tool

The legacy templates are at `_legacy/src/summary/templates.ts`. Read them and adapt to render output from `daily_metrics` / `weekly_metrics` / `monthly_metrics`.

**Files:**
- Create: `mcp-server/src/tools/health-summary.ts`
- Create: `mcp-server/src/tools/health-summary.test.ts`
- Create: `mcp-server/src/tools/templates.ts` (markdown rendering, ported from legacy)

- [ ] **Step 1: Read the legacy templates for reference**

```bash
cat _legacy/src/summary/templates.ts
```

Note the structure of the daily/weekly/monthly markdown blocks. Port the look-and-feel; do not port verbatim — column names changed.

- [ ] **Step 2: Write the failing test**

```typescript
// mcp-server/src/tools/health-summary.test.ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../db.ts';
import { healthSummary } from './health-summary.ts';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54322/postgres');
const adminPool = createPool('postgresql://postgres:postgres@127.0.0.1:54322/postgres');
afterAll(async () => { await pool.end(); await adminPool.end(); });

beforeEach(async () => {
  await adminPool.query('TRUNCATE health_samples, summary_cache');
});

describe('healthSummary', () => {
  it('renders a daily summary from data', async () => {
    await adminPool.query(
      `INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
       VALUES
         ('a', 'quantity', 'HKQuantityTypeIdentifierStepCount', 8000, 'count', '2026-04-01T10:00:00Z', '2026-04-01T10:30:00Z'),
         ('b', 'quantity', 'HKQuantityTypeIdentifierHeartRate',   72, 'count/min', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
    );
    const md = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    expect(md).toMatch(/2026-04-01/);
    expect(md).toMatch(/8[,\s]?000/);   // step count formatted, allow comma
    expect(md).toMatch(/72/);
  });

  it('returns "no data" markdown when no samples in range', async () => {
    const md = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    expect(md).toMatch(/no data/i);
  });

  it('reads from cache on the second call', async () => {
    await adminPool.query(
      `INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
       VALUES ('a', 'quantity', 'HKQuantityTypeIdentifierStepCount', 1, 'count', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
    );
    const first  = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    // Mutate underlying data; the cached output should still be returned.
    await adminPool.query("UPDATE health_samples SET value = 999 WHERE uuid = 'a'");
    const second = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    expect(second).toBe(first);
  });

  it('regenerates when cache is invalidated', async () => {
    await adminPool.query(
      `INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
       VALUES ('a', 'quantity', 'HKQuantityTypeIdentifierStepCount', 1, 'count', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
    );
    const first = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    await adminPool.query("UPDATE summary_cache SET invalidated = true");
    await adminPool.query("UPDATE health_samples SET value = 12345 WHERE uuid = 'a'");
    const second = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    expect(second).not.toBe(first);
    expect(second).toMatch(/12[,\s]?345/);
  });
});
```

- [ ] **Step 3: Run; expect failure**

```bash
cd mcp-server
npm test -- health-summary.test.ts
cd ..
```

Expected: `Cannot find module './health-summary.ts'`.

- [ ] **Step 4: Implement `templates.ts`**

```typescript
// mcp-server/src/tools/templates.ts
export interface DailyRow {
  day: Date;
  total_steps: number | null;
  avg_heart_rate: number | null;
  resting_heart_rate: number | null;
  hrv_mean: number | null;
  sleep_minutes: number | null;
  workout_count: number;
}

const fmtNum = (n: number | null, opts?: Intl.NumberFormatOptions) =>
  n === null ? '—' : new Intl.NumberFormat('en-US', opts).format(n);

const fmtMinutes = (m: number | null) => {
  if (m === null) return '—';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${h}h ${mm}m`;
};

export function renderDaily(date: string, row: DailyRow | undefined): string {
  if (!row) return `# Daily summary — ${date}\n\n_No data._`;
  return [
    `# Daily summary — ${date}`,
    '',
    `- **Steps:** ${fmtNum(row.total_steps, { maximumFractionDigits: 0 })}`,
    `- **Heart rate (avg):** ${fmtNum(row.avg_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Resting HR:** ${fmtNum(row.resting_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **HRV:** ${fmtNum(row.hrv_mean, { maximumFractionDigits: 1 })} ms`,
    `- **Sleep:** ${fmtMinutes(row.sleep_minutes)}`,
    `- **Workouts:** ${row.workout_count}`
  ].join('\n');
}

export function renderWeekly(weekStart: string, row: DailyRow | undefined): string {
  if (!row) return `# Weekly summary — week of ${weekStart}\n\n_No data._`;
  return [
    `# Weekly summary — week of ${weekStart}`,
    '',
    `- **Total steps:** ${fmtNum(row.total_steps, { maximumFractionDigits: 0 })}`,
    `- **Avg heart rate:** ${fmtNum(row.avg_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Avg resting HR:** ${fmtNum(row.resting_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Avg HRV:** ${fmtNum(row.hrv_mean, { maximumFractionDigits: 1 })} ms`,
    `- **Total sleep:** ${fmtMinutes(row.sleep_minutes)}`,
    `- **Workouts:** ${row.workout_count}`
  ].join('\n');
}

export function renderMonthly(monthStart: string, row: DailyRow | undefined): string {
  if (!row) return `# Monthly summary — ${monthStart}\n\n_No data._`;
  return [
    `# Monthly summary — ${monthStart}`,
    '',
    `- **Total steps:** ${fmtNum(row.total_steps, { maximumFractionDigits: 0 })}`,
    `- **Avg heart rate:** ${fmtNum(row.avg_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Avg resting HR:** ${fmtNum(row.resting_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Avg HRV:** ${fmtNum(row.hrv_mean, { maximumFractionDigits: 1 })} ms`,
    `- **Total sleep:** ${fmtMinutes(row.sleep_minutes)}`,
    `- **Workouts:** ${row.workout_count}`
  ].join('\n');
}
```

- [ ] **Step 5: Implement `health-summary.ts`**

```typescript
// mcp-server/src/tools/health-summary.ts
import type { Pool } from '../db.ts';
import { renderDaily, renderWeekly, renderMonthly, type DailyRow } from './templates.ts';

export type Period = 'day' | 'week' | 'month';

export interface HealthSummaryInput {
  period: Period;
  date?:  string;  // ISO date (YYYY-MM-DD); defaults to today in tz
  tz?:    string;  // IANA tz; defaults to UTC
}

function todayInTz(tz: string): string {
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); // en-CA gives YYYY-MM-DD
}

function startOfWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  // ISO week starts Monday (1) – shift Sunday (0) back 6.
  const diff = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function cacheKey(period: Period, date: string, tz: string): string {
  if (period === 'day')   return `daily:${date}:${tz}`;
  if (period === 'week')  return `weekly:${startOfWeek(date)}:${tz}`;
  return `monthly:${date.slice(0, 7)}:${tz}`;
}

async function getCached(pool: Pool, key: string): Promise<string | null> {
  const r = await pool.query<{ markdown: string }>(
    `SELECT markdown FROM summary_cache WHERE cache_key = $1 AND invalidated = false`,
    [key]
  );
  return r.rows[0]?.markdown ?? null;
}

async function putCached(pool: Pool, key: string, markdown: string): Promise<void> {
  await pool.query(
    `INSERT INTO summary_cache (cache_key, markdown, invalidated)
     VALUES ($1, $2, false)
     ON CONFLICT (cache_key) DO UPDATE SET
       markdown    = EXCLUDED.markdown,
       generated_at= now(),
       invalidated = false`,
    [key, markdown]
  );
}

export async function healthSummary(pool: Pool, input: HealthSummaryInput): Promise<string> {
  const tz   = input.tz   ?? 'UTC';
  const date = input.date ?? todayInTz(tz);
  const key  = cacheKey(input.period, date, tz);

  const cached = await getCached(pool, key);
  if (cached) return cached;

  let markdown: string;
  if (input.period === 'day') {
    const r = await pool.query<DailyRow>(
      `SELECT * FROM daily_metrics($1) WHERE day = $2`,
      [tz, date]
    );
    markdown = renderDaily(date, r.rows[0]);
  } else if (input.period === 'week') {
    const ws = startOfWeek(date);
    const r = await pool.query<DailyRow>(
      `SELECT week_start AS day, total_steps, avg_heart_rate, resting_heart_rate, hrv_mean, sleep_minutes, workout_count
         FROM weekly_metrics($1) WHERE week_start = $2`,
      [tz, ws]
    );
    markdown = renderWeekly(ws, r.rows[0]);
  } else {
    const ms = startOfMonth(date);
    const r = await pool.query<DailyRow>(
      `SELECT month_start AS day, total_steps, avg_heart_rate, resting_heart_rate, hrv_mean, sleep_minutes, workout_count
         FROM monthly_metrics($1) WHERE month_start = $2`,
      [tz, ms]
    );
    markdown = renderMonthly(ms, r.rows[0]);
  }

  await putCached(pool, key, markdown);
  return markdown;
}
```

- [ ] **Step 6: Re-run**

```bash
cd mcp-server
npm test -- health-summary.test.ts
cd ..
```

Expected: 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/tools/health-summary.ts mcp-server/src/tools/templates.ts mcp-server/src/tools/health-summary.test.ts
git commit -m "feat(mcp): add health_summary tool with cache"
```

---

### Task 3.6: `schema://tables` resource

**Files:**
- Create: `mcp-server/src/resources/schema.ts`
- Create: `mcp-server/src/resources/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// mcp-server/src/resources/schema.test.ts
import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from '../db.ts';
import { describeSchema } from './schema.ts';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54322/postgres');
afterAll(async () => { await pool.end(); });

describe('describeSchema', () => {
  it('lists known tables, views/functions, and example queries', async () => {
    const md = await describeSchema(pool);
    expect(md).toMatch(/health_samples/);
    expect(md).toMatch(/device_state/);
    expect(md).toMatch(/summary_cache/);
    expect(md).toMatch(/daily_metrics\(/);
    expect(md).toMatch(/detect_anomalies\(/);
    expect(md).toMatch(/example/i);
  });
});
```

- [ ] **Step 2: Run; expect failure**

```bash
cd mcp-server
npm test -- resources/schema.test.ts
cd ..
```

- [ ] **Step 3: Implement**

```typescript
// mcp-server/src/resources/schema.ts
import type { Pool } from '../db.ts';

interface ColumnRow { table_name: string; column_name: string; data_type: string; }

export async function describeSchema(pool: Pool): Promise<string> {
  const cols = await pool.query<ColumnRow>(`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('health_samples', 'device_state', 'summary_cache')
     ORDER BY table_name, ordinal_position
  `);

  const byTable: Record<string, ColumnRow[]> = {};
  for (const c of cols.rows) {
    (byTable[c.table_name] ??= []).push(c);
  }

  const tableSection = Object.entries(byTable).map(([name, rows]) =>
    [
      `### ${name}`,
      '',
      '| column | type |',
      '|---|---|',
      ...rows.map((r) => `| \`${r.column_name}\` | ${r.data_type} |`),
      ''
    ].join('\n')
  ).join('\n');

  return [
    '# oc-health-sync database',
    '',
    'You can query this database via the `run_sql` tool. The role is read-only on data tables.',
    '',
    '## Tables',
    '',
    tableSection,
    '## Set-returning functions',
    '',
    '- `daily_metrics(tz TEXT)` — per-day aggregations. Columns: `day`, `total_steps`, `avg_heart_rate`, `resting_heart_rate`, `hrv_mean`, `sleep_minutes`, `workout_count`.',
    '- `weekly_metrics(tz TEXT)` — same shape, weekly buckets. Bucket column is `week_start`.',
    '- `monthly_metrics(tz TEXT)` — same shape, monthly buckets. Bucket column is `month_start`.',
    '- `data_completeness(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_tz TEXT)` — per-day counts by `data_type` with gaps as 0.',
    '- `detect_anomalies(p_window_days INT)` — returns rows of `{ kind, severity, detail, ref_date }`. Severity is one of `info`, `warn`, `alert`.',
    '',
    '## Example queries',
    '',
    '```sql',
    '-- last 7 days of step counts',
    "SELECT day, total_steps FROM daily_metrics('UTC') ORDER BY day DESC LIMIT 7;",
    '',
    '-- heart-rate distribution last week',
    "SELECT date_trunc('hour', start_date) AS hour, AVG(value) FROM health_samples",
    " WHERE deleted_at IS NULL AND data_type = 'HKQuantityTypeIdentifierHeartRate'",
    "   AND start_date >= now() - INTERVAL '7 days'",
    ' GROUP BY 1 ORDER BY 1;',
    '```'
  ].join('\n');
}
```

- [ ] **Step 4: Re-run**

```bash
cd mcp-server
npm test -- resources/schema.test.ts
cd ..
```

Expected: 1 test passes.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/resources/schema.ts mcp-server/src/resources/schema.test.ts
git commit -m "feat(mcp): add schema://tables resource"
```

---

### Task 3.7: Server entry — wire up MCP + Streamable HTTP + auth

**Files:**
- Create: `mcp-server/src/index.ts` (replace placeholder)
- Create: `mcp-server/src/index.test.ts` (integration test against the actual server)

The MCP TS SDK package layout (verified via context7):
- `@modelcontextprotocol/server` — `McpServer`, `isInitializeRequest`
- `@modelcontextprotocol/express` — `createMcpExpressApp`
- `@modelcontextprotocol/node` — `NodeStreamableHTTPServerTransport`

- [ ] **Step 1: Write the failing integration test**

```typescript
// mcp-server/src/index.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './index.ts';

describe('mcp server end-to-end', () => {
  let close: () => Promise<void>;
  let port: number;

  beforeAll(async () => {
    process.env.MCP_API_KEY = 'mcp-test-key';
    process.env.MCP_DATABASE_URL = 'postgresql://read_user:read_pw@127.0.0.1:54322/postgres';
    const handle = await startServer(0);
    close = handle.close;
    port = handle.port;
  });

  afterAll(async () => { await close(); });

  it('rejects /mcp without auth', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  it('accepts an initialize request with auth and lists tools', async () => {
    // 1. initialize
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer mcp-test-key',
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
      })
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await init.body?.cancel();

    // 2. tools/list
    const list = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer mcp-test-key',
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'mcp-session-id': sessionId!
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toMatch(/health_summary/);
    expect(text).toMatch(/health_anomalies/);
    expect(text).toMatch(/run_sql/);
  });
});
```

- [ ] **Step 2: Run; expect failure**

```bash
cd mcp-server
npm test -- index.test.ts
cd ..
```

Expected: compile error referencing missing `startServer`.

- [ ] **Step 3: Implement `index.ts`**

```typescript
// mcp-server/src/index.ts
import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer, isInitializeRequest } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';

import { bearerAuth } from './auth.ts';
import { createPool, type Pool } from './db.ts';
import { healthSummary } from './tools/health-summary.ts';
import { healthAnomalies } from './tools/health-anomalies.ts';
import { runSql } from './tools/run-sql.ts';
import { describeSchema } from './resources/schema.ts';

function buildMcp(pool: Pool): McpServer {
  const server = new McpServer({ name: 'oc-health-sync', version: '0.1.0' });

  server.registerTool(
    'health_summary',
    {
      description: 'Daily, weekly, or monthly health summary as markdown.',
      inputSchema: z.object({
        period: z.enum(['day', 'week', 'month']),
        date:   z.string().optional(),
        tz:     z.string().optional()
      })
    },
    async (input) => ({ content: [{ type: 'text', text: await healthSummary(pool, input) }] })
  );

  server.registerTool(
    'health_anomalies',
    {
      description: 'Detected anomalies in the trailing window (default 14 days).',
      inputSchema: z.object({ window_days: z.number().int().positive().optional() })
    },
    async (input) => ({ content: [{ type: 'text', text: await healthAnomalies(pool, input) }] })
  );

  server.registerTool(
    'run_sql',
    {
      description: 'Run a single read-only SQL statement against the health database. 5s statement timeout. Use `schema://tables` to discover the schema.',
      inputSchema: z.object({ query: z.string().min(1) })
    },
    async (input) => {
      const result = await runSql(pool, input);
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
    }
  );

  server.registerResource(
    'schema',
    'schema://tables',
    { description: 'Database schema summary and example queries.', mimeType: 'text/markdown' },
    async () => ({
      contents: [{ uri: 'schema://tables', mimeType: 'text/markdown', text: await describeSchema(pool) }]
    })
  );

  return server;
}

export interface ServerHandle {
  port:  number;
  close: () => Promise<void>;
}

export async function startServer(requestedPort: number): Promise<ServerHandle> {
  const dsn = process.env.MCP_DATABASE_URL;
  if (!dsn) throw new Error('MCP_DATABASE_URL is not set');
  const pool = createPool(dsn);

  const mcp = buildMcp(pool);
  const app = createMcpExpressApp();
  app.use(express.json());
  app.use(bearerAuth);

  const transports = new Map<string, NodeStreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => transports.set(sid, transport!)
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      await mcp.connect(transport);
    }

    if (!transport) {
      res.status(400).json({ error: 'no session' });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const s = app.listen(requestedPort, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const t of transports.values()) await t.close();
      await pool.end();
    }
  };
}

if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  const port = Number(process.env.MCP_PORT ?? 3737);
  startServer(port).then((h) => {
    console.log(`mcp-server listening on http://127.0.0.1:${h.port}/mcp`);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Re-run**

```bash
cd mcp-server
npm test -- index.test.ts
cd ..
```

Expected: 2 tests pass. If `health_summary` etc. don't show up in `tools/list`, double-check the SDK version and how `registerTool` is exported.

- [ ] **Step 5: Run the full MCP test suite**

```bash
cd mcp-server
npm test
cd ..
```

Expected: every test in the package passes.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/index.ts mcp-server/src/index.test.ts
git commit -m "feat(mcp): wire MCP server with Streamable HTTP transport and auth"
```

---

## Phase 4 — Deployment

### Task 4.1: Dockerfile for the MCP server

**Files:**
- Create: `mcp-server/Dockerfile`
- Create: `mcp-server/.dockerignore`

- [ ] **Step 1: Write `mcp-server/.dockerignore`**

```
node_modules
dist
*.log
.env
__tests__
src/**/*.test.ts
```

- [ ] **Step 2: Write `mcp-server/Dockerfile`**

```dockerfile
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3737
CMD ["node", "dist/index.js"]
```

- [ ] **Step 3: Build the image locally**

```bash
cd mcp-server
docker build -t oc-health-sync-mcp:dev .
cd ..
```

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/Dockerfile mcp-server/.dockerignore
git commit -m "chore(mcp): add Dockerfile"
```

---

### Task 4.2: docker-compose for the full stack

**Files:**
- Create: `deploy/docker-compose.yml`
- Create: `deploy/.env.example`

- [ ] **Step 1: Write `deploy/.env.example`**

```bash
# Postgres
POSTGRES_PASSWORD=changeme-postgres
JWT_SECRET=changeme-jwt-min-32-chars-please-change

# Supabase self-host (subset; see supabase/docker for the full list)
ANON_KEY=changeme-anon-jwt
SERVICE_ROLE_KEY=changeme-service-jwt

# Edge Function ingest
INGEST_API_KEY=changeme-ingest-bearer
# Connection string the ingest function uses. Points at the in-network postgres.
INGEST_DATABASE_URL=postgresql://ingest_user:changeme-ingest-pw@db:5432/postgres

# MCP server
MCP_API_KEY=changeme-mcp-bearer
MCP_PORT=3737
MCP_DATABASE_URL=postgresql://read_user:changeme-read-pw@db:5432/postgres

# Per-environment login users for the two roles. Created by deploy/init-users.sql,
# which is mounted into the postgres container's /docker-entrypoint-initdb.d/.
INGEST_USER_PASSWORD=changeme-ingest-pw
READ_USER_PASSWORD=changeme-read-pw
```

- [ ] **Step 2: Write `deploy/init-users.sh`**

A small shell script the operator runs once after the migrations are applied. It reads passwords from the loaded environment and uses `psql` to create the login users and grant them the parent roles. We do this in shell rather than SQL because we need to interpolate env-var passwords safely.

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${INGEST_USER_PASSWORD:?must be set in .env}"
: "${READ_USER_PASSWORD:?must be set in .env}"
: "${POSTGRES_PASSWORD:?must be set in .env}"

ADMIN_DSN="postgresql://postgres:${POSTGRES_PASSWORD}@127.0.0.1:54322/postgres"

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
```

Make it executable and check it into the repo. The operator runs it once after `docker compose up` and the migration-apply step.

Note: the passwords are interpolated server-side via heredoc, which means they're transient (only in the local shell). They are **not** the same as the bearer API keys; bearers gate Edge Function and MCP server access, while these passwords are how the in-cluster services authenticate to Postgres.

- [ ] **Step 3: Write `deploy/docker-compose.mcp.yml` (compose overlay)**

The Supabase self-host stack has many interdependent services (db, kong, auth, rest, realtime, storage, meta, studio, functions, vector, pooler) — reproducing it here would just diverge from upstream. Instead we ship an **overlay** compose file that the operator combines with the official `docker/docker-compose.yml` from the supabase repo. The overlay adds our MCP server and overrides the env the Edge Function needs.

Create `deploy/docker-compose.mcp.yml`:

```yaml
# Overlay: combine with supabase/docker/docker-compose.yml from the upstream repo:
#   docker compose -f /path/to/supabase/docker/docker-compose.yml -f docker-compose.mcp.yml up -d
#
# This file intentionally does NOT redefine db / kong / functions / studio — those
# come from the upstream compose. We only:
#   - inject INGEST_API_KEY and INGEST_DATABASE_URL into the functions container
#   - add our mcp-server service on the same network

name: oc-health-sync

services:
  functions:
    environment:
      INGEST_API_KEY: ${INGEST_API_KEY}
      INGEST_DATABASE_URL: ${INGEST_DATABASE_URL}

  mcp:
    build:
      context: ../mcp-server
      dockerfile: Dockerfile
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

The operator follows the upstream Supabase self-hosting guide ([supabase.com/docs/guides/self-hosting/docker](https://supabase.com/docs/guides/self-hosting/docker)) to obtain the base compose, then layers our overlay on top.

- [ ] **Step 4: Commit**

```bash
chmod +x deploy/init-users.sh
git add deploy/.env.example deploy/init-users.sh deploy/docker-compose.mcp.yml
git commit -m "chore(deploy): add compose overlay, env template, init-users helper"
```

---

### Task 4.3: Deploy README

**Files:**
- Create: `deploy/README.md`

- [ ] **Step 1: Write `deploy/README.md`**

```markdown
# Deploying oc-health-sync to a VPS

This guide assumes a Linux VPS, Docker, and Tailscale.

## 1. Install prerequisites

```bash
# Docker
curl -fsSL https://get.docker.com | sh
# Tailscale
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

## 2. Get the code

```bash
git clone https://github.com/dominikx96/oc-health-sync.git
cd oc-health-sync
```

## 3. Configure secrets

```bash
cp deploy/.env.example deploy/.env
# Edit deploy/.env — generate strong values for POSTGRES_PASSWORD,
# JWT_SECRET, INGEST_API_KEY, MCP_API_KEY, INGEST_USER_PASSWORD, READ_USER_PASSWORD.
# Ensure INGEST_DATABASE_URL and MCP_DATABASE_URL match the user passwords.
```

## 4. Get the official Supabase self-host compose

We layer our overlay on top of the upstream stack rather than re-creating it.

```bash
# Anywhere on the VPS, e.g. ~/supabase-base
git clone --depth 1 https://github.com/supabase/supabase ~/supabase-base
# Copy the operator-tunable env file as a starting point.
cp ~/supabase-base/docker/.env.example ~/supabase-base/docker/.env
# Merge our overlay-specific vars into it (or symlink and source both).
cat deploy/.env >> ~/supabase-base/docker/.env
```

Read [supabase.com/docs/guides/self-hosting/docker](https://supabase.com/docs/guides/self-hosting/docker) for current instructions on the upstream env vars.

## 5. Bring the stack up

```bash
cd ~/supabase-base/docker
docker compose \
  -f docker-compose.yml \
  -f /path/to/oc-health-sync/deploy/docker-compose.mcp.yml \
  up -d
docker compose logs -f db   # wait for "database system is ready to accept connections"
```

## 6. Apply migrations

```bash
cd /path/to/oc-health-sync
PGPASSWORD=$POSTGRES_PASSWORD psql \
  -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -f supabase/migrations/20260507000000_init_tables.sql
PGPASSWORD=$POSTGRES_PASSWORD psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -f supabase/migrations/20260507000100_roles.sql
PGPASSWORD=$POSTGRES_PASSWORD psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -f supabase/migrations/20260507000200_metrics_views.sql
PGPASSWORD=$POSTGRES_PASSWORD psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -f supabase/migrations/20260507000300_data_completeness.sql
PGPASSWORD=$POSTGRES_PASSWORD psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
  -f supabase/migrations/20260507000400_detect_anomalies.sql
```

(If the Supabase CLI is installed on the VPS, `supabase db push --db-url "postgresql://postgres:$POSTGRES_PASSWORD@127.0.0.1:54322/postgres"` from inside the repo applies all of them in one shot.)

## 7. Create login users and grant role memberships

```bash
cd /path/to/oc-health-sync
set -a; source deploy/.env; set +a
./deploy/init-users.sh
```

## 8. Restart the MCP container so it picks up the now-existing read_user

```bash
docker compose -f /path/to/supabase-base/docker/docker-compose.yml \
               -f /path/to/oc-health-sync/deploy/docker-compose.mcp.yml \
               restart mcp
```

## 9. Expose to your tailnet

```bash
# Edge Function ingest (Kong gateway, default 8000)
sudo tailscale serve --bg --tcp 8000 8000

# MCP server
sudo tailscale serve --bg --tcp $MCP_PORT $MCP_PORT
```

Verify:
```bash
tailscale serve status
```

Both should appear with their respective ports. **Do not** use `tailscale funnel` — that exposes services to the public internet.

## 10. Configure the iOS app

In the oc-health-sync iOS app:
- **Server URL:** `http://<tailscale-ip>:8000/functions/v1/ingest`
- **API key:** the value of `INGEST_API_KEY` from your `.env`.

Tap **Test Connection** in the app.

## 11. Configure your MCP client

Whichever client you use (Claude Desktop, VS Code MCP, etc.), point it at:
- **URL:** `http://<tailscale-ip>:$MCP_PORT/mcp`
- **Auth header:** `Authorization: Bearer $MCP_API_KEY`

## Smoke test

```bash
cd /path/to/oc-health-sync
set -a; source deploy/.env; set +a
INGEST_URL=http://127.0.0.1:8000/functions/v1/ingest \
MCP_URL=http://127.0.0.1:$MCP_PORT/mcp \
./deploy/smoke.sh
```

## Backup

The Postgres data lives in the upstream Supabase compose's `db-config` / `db-data` volumes. Snapshot with:

```bash
docker run --rm -v supabase_db-config:/data -v "$PWD":/backup alpine \
  tar czf /backup/db-backup-$(date +%F).tar.gz /data
```
(Volume names depend on the upstream compose's `name:` directive. Check `docker volume ls` to find the actual names.)
```

- [ ] **Step 2: Commit**

```bash
git add deploy/README.md
git commit -m "docs(deploy): add VPS deploy guide"
```

---

### Task 4.4: Smoke test

**Files:**
- Create: `deploy/smoke.sh`

- [ ] **Step 1: Write `deploy/smoke.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

: "${INGEST_API_KEY:?must be set}"
: "${MCP_API_KEY:?must be set}"
: "${MCP_PORT:=3737}"

INGEST_URL="${INGEST_URL:-http://127.0.0.1:8000/functions/v1/ingest}"
MCP_URL="${MCP_URL:-http://127.0.0.1:$MCP_PORT/mcp}"

echo "→ Ingest a test sample"
TODAY="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
RESPONSE=$(curl -sS -X POST "$INGEST_URL" \
  -H "Authorization: Bearer $INGEST_API_KEY" \
  -H "Content-Type: application/json" \
  -d "{
    \"device_id\": \"smoke-test\",
    \"new_samples\": [{
      \"uuid\": \"smoke-$RANDOM\",
      \"sample_kind\": \"quantity\",
      \"data_type\": \"HKQuantityTypeIdentifierStepCount\",
      \"value\": 4242,
      \"unit\": \"count\",
      \"start_date\": \"$TODAY\",
      \"end_date\":   \"$TODAY\",
      \"source_name\": \"smoke\"
    }],
    \"deleted_ids\": []
  }")
echo "  $RESPONSE"
echo "$RESPONSE" | grep -q '"stored":1' || { echo "FAIL: ingest did not store the sample"; exit 1; }

echo "→ Initialize MCP session"
INIT=$(curl -sS -i -X POST "$MCP_URL" \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}')
SESSION_ID=$(echo "$INIT" | tr -d '\r' | awk -F': ' 'tolower($1)=="mcp-session-id" {print $2; exit}')
[[ -n "$SESSION_ID" ]] || { echo "FAIL: no session id"; exit 1; }
echo "  session $SESSION_ID"

echo "→ Call health_summary tool"
SUMMARY=$(curl -sS -X POST "$MCP_URL" \
  -H "Authorization: Bearer $MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -H "Mcp-Session-Id: $SESSION_ID" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"health_summary\",\"arguments\":{\"period\":\"day\",\"tz\":\"UTC\"}}}")
echo "  $SUMMARY" | head -c 200
echo
echo "$SUMMARY" | grep -qi 'daily summary' || { echo "FAIL: health_summary did not return markdown"; exit 1; }

echo "✓ smoke test passed"
```

- [ ] **Step 2: Make it executable**

```bash
chmod +x deploy/smoke.sh
```

- [ ] **Step 3: Run it locally against the dev stack**

```bash
# Bring up the dev stack first (or use supabase start + npm run dev for the MCP server).
cd deploy
INGEST_API_KEY=test-ingest-key \
MCP_API_KEY=mcp-test-key \
MCP_PORT=3737 \
INGEST_URL=http://127.0.0.1:54321/functions/v1/ingest \
./smoke.sh
cd ..
```

Expected: `✓ smoke test passed`.

- [ ] **Step 4: Commit**

```bash
git add deploy/smoke.sh
git commit -m "test(deploy): add end-to-end smoke script"
```

---

## Phase 5 — Cleanup

### Task 5.1: Top-level README

**Files:**
- Modify: `README.md` (replace placeholder)

- [ ] **Step 1: Replace the root `README.md`**

```markdown
# oc-health-sync

Self-hosted Supabase + MCP server for ingesting Apple HealthKit data and exposing it to MCP-compatible clients (Claude Desktop, Hermes, Cursor, etc.). Runs on a single VPS, isolated to a Tailscale tailnet.

- **Ingest:** the iOS app POSTs HealthKit samples to a Supabase Edge Function over Tailscale.
- **Query:** any MCP client connects to the MCP server (over Tailscale) to call `health_summary`, `health_anomalies`, or `run_sql`, and to read the `schema://tables` resource.
- **No public exposure** — everything is tailnet-only.

## Layout

- `supabase/` — SQL migrations, the `ingest` Edge Function, seed data.
- `mcp-server/` — Node 24 + TypeScript MCP server (`@modelcontextprotocol/sdk`).
- `deploy/` — `docker-compose.yml`, `.env.example`, deploy guide, smoke test.

## Deploying

See [`deploy/README.md`](./deploy/README.md).

## Development

```bash
# 1. Bring up local Supabase (Postgres + Studio + Edge Functions runtime)
cd supabase && supabase start

# 2. Apply migrations and seed
supabase db reset

# 3. Run the Edge Function locally
INGEST_API_KEY=test-ingest-key \
INGEST_DATABASE_URL='postgresql://ingest_user:ingest_pw@127.0.0.1:54322/postgres' \
supabase functions serve ingest --no-verify-jwt

# 4. In another terminal, run the MCP server
cd mcp-server
MCP_API_KEY=mcp-test-key \
MCP_DATABASE_URL='postgresql://read_user:read_pw@127.0.0.1:54322/postgres' \
npm run dev
```

Tests:

```bash
# Schema tests
for t in supabase/tests/*.test.sql; do
  psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -f "$t" || exit 1
done

# Edge Function tests
cd supabase/functions/ingest && deno test --allow-env --allow-net --allow-read

# MCP server tests
cd mcp-server && npm test
```

## MCP client identity prompt

For best results, your MCP client should be configured with a "Health Analyst" persona. Suggested identity:

> You are a personal health data analyst. You have access to the user's Apple HealthKit data via the `oc-health-sync` MCP server. Lead with the most relevant finding. Compare current values to recent trends. Flag anomalies proactively. Use exact numbers with units. Never diagnose or prescribe — report what the data shows.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: rewrite top-level README for new architecture"
```

---

### Task 5.2: Remove `_legacy/`

Only do this once the entire stack has been smoke-tested end to end on the actual VPS, not just locally. Until then, keep it for reference.

**Files:**
- Delete: `_legacy/` (entire directory)
- Modify: `agent_example/` — leave alone; that was an unrelated experiment.

- [ ] **Step 1: Confirm no remaining references to `_legacy/`**

```bash
grep -rn '_legacy' --exclude-dir=_legacy --exclude-dir=node_modules --exclude-dir=.git . || true
```

Expected: zero matches outside `docs/superpowers/` (the spec/plan reference legacy paths in prose; that's fine).

- [ ] **Step 2: Delete the directory**

```bash
git rm -rf _legacy
```

- [ ] **Step 3: Commit**

```bash
git commit -m "chore: remove _legacy/ — rewrite complete"
```

---

## Done

After Task 5.2 the rewrite is complete. Run the local test suites one final time:

```bash
# Schema
for t in supabase/tests/*.test.sql; do
  psql 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' -f "$t" || exit 1
done
# Edge Function
cd supabase/functions/ingest && deno test --allow-env --allow-net --allow-read
cd ../../..
# MCP
cd mcp-server && npm test
cd ..
# Smoke
INGEST_API_KEY=test-ingest-key MCP_API_KEY=mcp-test-key MCP_PORT=3737 \
  INGEST_URL=http://127.0.0.1:54321/functions/v1/ingest deploy/smoke.sh
```

All four should report success.
