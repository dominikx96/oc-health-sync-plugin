# Daily-log table + `without_break` on training_sets — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `daily_logs` table for per-day lifestyle facts (alcohol boolean + free-text notes) plus a `without_break` boolean on `training_sets`, both exposed end-to-end through MCP.

**Architecture:** Three additive, idempotent SQL migrations (table + column + `CREATE OR REPLACE` function). One new MCP tool (`health_log_day`) doing an upsert through the existing `writePool` (`gym_writer_role` is widened to own `daily_logs`). Existing gym tools (`gym_log_set`, `gym_submit_session_bulk`) gain an optional `without_break` field. Schema resource lists the new table and column.

**Tech Stack:** Postgres 15 + Supabase CLI; Node 24 + TypeScript MCP server; `pg` for DB; `zod` for input schemas; `vitest` for TS tests; `psql -f` for SQL tests.

**Spec:** [`docs/superpowers/specs/2026-05-14-daily-log-and-without-break-design.md`](../specs/2026-05-14-daily-log-and-without-break-design.md) (commit `f482e57`).

**Repo conventions to follow:**
- All migrations idempotent (`CREATE … IF NOT EXISTS`, `CREATE OR REPLACE`, `ADD COLUMN IF NOT EXISTS`).
- Old MCP image must keep working against the new schema (additive, defaulted).
- Local Postgres runs on port `54422` (per `supabase/config.toml`).
- SQL tests live in `supabase/tests/*.test.sql` and are executed with `psql -f`.
- TS tests live next to source as `*.test.ts` and run via `npm test` (vitest).
- After every migration change: re-run `supabase db reset` from `supabase/` to re-apply migrations + seed.

---

## File Structure

**New files:**
- `supabase/migrations/20260514000000_daily_logs.sql` — table + grants
- `supabase/migrations/20260514000100_training_sets_without_break.sql` — single ALTER
- `supabase/migrations/20260514000200_last_exercise_results_v2.sql` — `CREATE OR REPLACE FUNCTION` extending JSONB
- `supabase/tests/daily_logs_schema.test.sql` — schema shape + upsert sanity
- `supabase/tests/daily_logs_roles.test.sql` — role grants + REVOKE regression
- `mcp-server/src/tools/health-log-day.ts` — upsert tool
- `mcp-server/src/tools/health-log-day.test.ts` — round-trip vitest

**Modified files:**
- `supabase/seed.sql` — add TRUNCATE grant for `gym_writer_user` on `daily_logs`
- `supabase/tests/gym_schema.test.sql` — assert `without_break` column + default
- `supabase/tests/gym_helpers.test.sql` — assert `without_break` key in `last_exercise_results` JSON
- `mcp-server/src/tools/gym/sets.ts` — `LogSetInput.without_break`; INSERT column
- `mcp-server/src/tools/gym/sets.test.ts` — round-trip test
- `mcp-server/src/tools/gym/bulk.ts` — `SetSchema.without_break`; INSERT column
- `mcp-server/src/tools/gym/bulk.test.ts` — round-trip test
- `mcp-server/src/tools/gym/lookup.ts` — `LastExerciseRow.sets[].without_break`
- `mcp-server/src/index.ts` — register `health_log_day`; add `without_break` to two existing zod schemas
- `mcp-server/src/index.test.ts` — assert `health_log_day` in tools list
- `mcp-server/src/resources/schema.ts` — allowlist `daily_logs`; prose + example query
- `mcp-server/src/resources/schema.test.ts` — assert `daily_logs` and `without_break` appear

---

## Task 1: SQL migration — `daily_logs` table

**Files:**
- Create: `supabase/migrations/20260514000000_daily_logs.sql`
- Create: `supabase/tests/daily_logs_schema.test.sql`
- Create: `supabase/tests/daily_logs_roles.test.sql`

- [ ] **Step 1: Write the failing schema test**

Create `supabase/tests/daily_logs_schema.test.sql`:

```sql
-- Verify daily_logs schema shape and upsert semantics.
TRUNCATE daily_logs;

DO $$
DECLARE
  rec RECORD;
BEGIN
  -- Column shape via information_schema.
  SELECT is_nullable, data_type INTO rec
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'daily_logs' AND column_name = 'alcohol';
  IF rec.is_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'expected alcohol to be nullable, got is_nullable=%', rec.is_nullable;
  END IF;
  IF rec.data_type IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'expected alcohol boolean, got %', rec.data_type;
  END IF;

  SELECT is_nullable INTO rec
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'daily_logs' AND column_name = 'tz';
  IF rec.is_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'expected tz NOT NULL, got is_nullable=%', rec.is_nullable;
  END IF;

  -- Primary key on (day).
  PERFORM 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema, table_name)
   WHERE tc.table_schema = 'public' AND tc.table_name = 'daily_logs'
     AND tc.constraint_type = 'PRIMARY KEY' AND kcu.column_name = 'day';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expected PRIMARY KEY on daily_logs(day)';
  END IF;

  -- Upsert sanity: same day twice updates rather than duplicating.
  INSERT INTO daily_logs (day, tz, alcohol, notes)
    VALUES ('2026-05-14', 'Europe/Warsaw', true, 'pierwszy wpis');
  INSERT INTO daily_logs (day, tz, alcohol, notes)
    VALUES ('2026-05-14', 'Europe/Warsaw', false, 'drugi wpis')
    ON CONFLICT (day) DO UPDATE
       SET alcohol = EXCLUDED.alcohol, notes = EXCLUDED.notes, updated_at = now();

  IF (SELECT COUNT(*) FROM daily_logs WHERE day = '2026-05-14') <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 row after upsert';
  END IF;
  IF (SELECT alcohol FROM daily_logs WHERE day = '2026-05-14') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'expected alcohol=false after upsert';
  END IF;

  RAISE NOTICE 'daily_logs_schema.test.sql OK';
END $$;

TRUNCATE daily_logs;
```

- [ ] **Step 2: Write the failing roles test**

Create `supabase/tests/daily_logs_roles.test.sql`:

```sql
DO $$
BEGIN
  -- gym_writer_role can write daily_logs.
  IF NOT has_table_privilege('gym_writer_role', 'public.daily_logs', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role missing INSERT on daily_logs';
  END IF;
  IF NOT has_table_privilege('gym_writer_role', 'public.daily_logs', 'UPDATE') THEN
    RAISE EXCEPTION 'gym_writer_role missing UPDATE on daily_logs';
  END IF;
  IF NOT has_table_privilege('gym_writer_role', 'public.daily_logs', 'SELECT') THEN
    RAISE EXCEPTION 'gym_writer_role missing SELECT on daily_logs';
  END IF;

  -- health_read_role can only SELECT.
  IF NOT has_table_privilege('health_read_role', 'public.daily_logs', 'SELECT') THEN
    RAISE EXCEPTION 'health_read_role missing SELECT on daily_logs';
  END IF;
  IF has_table_privilege('health_read_role', 'public.daily_logs', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role should NOT have INSERT on daily_logs';
  END IF;

  -- Existing REVOKE on health tables must still hold (regression).
  IF has_table_privilege('gym_writer_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role regressed: now has INSERT on health_samples';
  END IF;
  IF has_table_privilege('gym_writer_role', 'public.device_state', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role regressed: now has INSERT on device_state';
  END IF;

  RAISE NOTICE 'daily_logs_roles.test.sql OK';
END $$;
```

- [ ] **Step 3: Run both tests to verify they fail**

Run from the repo root:

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/daily_logs_schema.test.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/daily_logs_roles.test.sql
```

Expected: both fail with `ERROR: relation "daily_logs" does not exist` (or similar).

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260514000000_daily_logs.sql`:

```sql
-- Per-day, manually-entered lifestyle facts. One row per local day.
-- Upsertable via the MCP `health_log_day` tool. Idempotent migration.

CREATE TABLE IF NOT EXISTS daily_logs (
  day         DATE        PRIMARY KEY,
  tz          TEXT        NOT NULL,
  alcohol     BOOLEAN,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Explicit grants. ALTER DEFAULT PRIVILEGES covers SELECT for read roles, but write
-- grants and the gym_writer_role write surface must be explicit.
GRANT SELECT                  ON daily_logs TO health_read_role;
GRANT INSERT, UPDATE, SELECT  ON daily_logs TO gym_writer_role;
-- The existing REVOKE on health_samples/device_state/summary_cache from gym_writer_role
-- in 20260511000100_gym_roles.sql stays in place — daily_logs is the only health-domain
-- table that gym_writer_role is allowed to write.
```

- [ ] **Step 5: Re-apply migrations and run tests to verify they pass**

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/daily_logs_schema.test.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/daily_logs_roles.test.sql
```

Expected output for each: `NOTICE:  daily_logs_<…>.test.sql OK`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260514000000_daily_logs.sql \
        supabase/tests/daily_logs_schema.test.sql \
        supabase/tests/daily_logs_roles.test.sql
git commit -m "feat(db): daily_logs table with gym_writer_role write grant"
```

---

## Task 2: SQL migration — `training_sets.without_break`

**Files:**
- Create: `supabase/migrations/20260514000100_training_sets_without_break.sql`
- Modify: `supabase/tests/gym_schema.test.sql:65` (extend section 4)

- [ ] **Step 1: Extend the gym schema test to assert `without_break`**

Edit `supabase/tests/gym_schema.test.sql`. Inside the `DO $$` block, **after** the line that inserts the OK reps-only set (`'st-ok'`, around line 64), append a new section before the `-- 5. gym_machines NULL-safe uniqueness` comment:

```sql
  -- 4b. without_break defaults to false; explicit true is preserved.
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'training_sets'
     AND column_name = 'without_break' AND data_type = 'boolean' AND is_nullable = 'NO'
     AND column_default = 'false';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expected without_break BOOLEAN NOT NULL DEFAULT false on training_sets';
  END IF;

  -- Default-false on a set that does not pass the column.
  IF (SELECT without_break FROM training_sets WHERE uuid = 'st-ok') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'expected without_break default false on existing set';
  END IF;

  -- Explicit true is stored.
  INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, without_break)
    VALUES ('st-no-break', te_id, 2, 8, true);
  IF (SELECT without_break FROM training_sets WHERE uuid = 'st-no-break') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'expected without_break=true to be stored';
  END IF;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_schema.test.sql
```

Expected: `ERROR: expected without_break BOOLEAN NOT NULL DEFAULT false on training_sets`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260514000100_training_sets_without_break.sql`:

```sql
-- Mark a set as performed without rest before it (drop set / rest-pause / "one more").
-- Defaulted false so existing rows (and the previous MCP image) stay valid.

ALTER TABLE training_sets
  ADD COLUMN IF NOT EXISTS without_break BOOLEAN NOT NULL DEFAULT false;
```

- [ ] **Step 4: Re-apply migrations and run the test to verify it passes**

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_schema.test.sql
```

Expected: `NOTICE:  gym_schema.test.sql OK`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260514000100_training_sets_without_break.sql \
        supabase/tests/gym_schema.test.sql
git commit -m "feat(db): without_break boolean on training_sets"
```

---

## Task 3: SQL migration — extend `last_exercise_results` JSONB

**Files:**
- Create: `supabase/migrations/20260514000200_last_exercise_results_v2.sql`
- Modify: `supabase/tests/gym_helpers.test.sql` (extend last_exercise_results assertions)

- [ ] **Step 1: Extend the gym helpers test to assert the new JSON key**

Edit `supabase/tests/gym_helpers.test.sql`. Add a `without_break` column to the second `INSERT INTO training_sets` (the recent Mokotów one — at the line that inserts `'st-mok-1'`):

Change the existing line:

```sql
  INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg, rpe)
    VALUES ('st-mok-1', te_recent, 1, 10, 60, 8);
```

to:

```sql
  INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg, rpe, without_break)
    VALUES ('st-mok-1', te_recent, 1, 10, 60, 8, true);
```

Then inside the `FOR r IN SELECT * FROM last_exercise_results(...)` loop, replace the existing same_gym block (around line 73) so the first row also asserts the JSON key is present:

Change:

```sql
    IF rows_seen = 1 THEN
      IF NOT r.same_gym THEN RAISE EXCEPTION 'first row should be same_gym'; END IF;
      IF jsonb_array_length(r.sets) <> 2 THEN
        RAISE EXCEPTION 'expected 2 sets on same-gym row, got %', jsonb_array_length(r.sets);
      END IF;
    ELSIF rows_seen = 2 THEN
      IF r.same_gym THEN RAISE EXCEPTION 'second row should be other-gym'; END IF;
    END IF;
```

to:

```sql
    IF rows_seen = 1 THEN
      IF NOT r.same_gym THEN RAISE EXCEPTION 'first row should be same_gym'; END IF;
      IF jsonb_array_length(r.sets) <> 2 THEN
        RAISE EXCEPTION 'expected 2 sets on same-gym row, got %', jsonb_array_length(r.sets);
      END IF;
      -- Every set object must carry the without_break key (default false on these).
      IF NOT (r.sets -> 0 ? 'without_break') THEN
        RAISE EXCEPTION 'expected without_break key in same-gym sets[0], got %', r.sets -> 0;
      END IF;
      IF (r.sets -> 0 ->> 'without_break')::boolean IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'expected without_break=false on default set, got %', r.sets -> 0;
      END IF;
    ELSIF rows_seen = 2 THEN
      IF r.same_gym THEN RAISE EXCEPTION 'second row should be other-gym'; END IF;
      IF (r.sets -> 0 ->> 'without_break')::boolean IS DISTINCT FROM true THEN
        RAISE EXCEPTION 'expected without_break=true on Mokotów set, got %', r.sets -> 0;
      END IF;
    END IF;
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_helpers.test.sql
```

Expected: `ERROR: expected without_break key in same-gym sets[0]` (the function still builds JSON without that key).

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260514000200_last_exercise_results_v2.sql`. The signature is unchanged so the old MCP image still gets a valid row; the JSON gains one key:

```sql
-- Extend last_exercise_results JSONB output with the new without_break flag.
-- Signature unchanged → previous MCP image keeps working.

CREATE OR REPLACE FUNCTION last_exercise_results(
  p_exercise_id    BIGINT,
  p_current_gym_id BIGINT
) RETURNS TABLE (
  training_exercise_id BIGINT,
  session_id           BIGINT,
  gym_id               BIGINT,
  gym_slug             TEXT,
  same_gym             BOOLEAN,
  performed_at         TIMESTAMPTZ,
  sets                 JSONB
) LANGUAGE sql STABLE AS $$
  WITH candidate AS (
    SELECT te.id AS training_exercise_id,
           te.session_id,
           s.gym_id, g.slug AS gym_slug,
           (s.gym_id = p_current_gym_id) AS same_gym,
           s.started_at AS performed_at
      FROM training_exercises te
      JOIN training_sessions s ON s.id = te.session_id AND s.deleted_at IS NULL
      JOIN gyms g              ON g.id = s.gym_id
     WHERE te.deleted_at IS NULL
       AND te.exercise_id = p_exercise_id
       AND s.ended_at IS NOT NULL
  ),
  ranked AS (
    SELECT c.*,
           ROW_NUMBER() OVER (PARTITION BY c.same_gym ORDER BY c.performed_at DESC) AS rn
      FROM candidate c
  )
  SELECT r.training_exercise_id,
         r.session_id,
         r.gym_id,
         r.gym_slug,
         r.same_gym,
         r.performed_at,
         (
           SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'set_index',     ts.set_index,
                   'reps',          ts.reps,
                   'weight_kg',     ts.weight_kg,
                   'rpe',           ts.rpe,
                   'is_warmup',     ts.is_warmup,
                   'without_break', ts.without_break,
                   'notes',         ts.notes
                 ) ORDER BY ts.set_index), '[]'::jsonb)
             FROM training_sets ts
            WHERE ts.training_exercise_id = r.training_exercise_id
              AND ts.deleted_at IS NULL
         ) AS sets
    FROM ranked r
   WHERE r.rn = 1
   ORDER BY r.same_gym DESC;
$$;
```

Note: `CREATE OR REPLACE FUNCTION` is idempotent. No GRANT line is needed — the prior grants on this function survive the replacement.

- [ ] **Step 4: Re-apply and run all gym SQL tests**

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_helpers.test.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_schema.test.sql
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_roles.test.sql
```

Expected: three `NOTICE:  *.test.sql OK` lines.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260514000200_last_exercise_results_v2.sql \
        supabase/tests/gym_helpers.test.sql
git commit -m "feat(db): last_exercise_results JSON gains without_break"
```

---

## Task 4: Seed — TRUNCATE grant for local dev

**Files:**
- Modify: `supabase/seed.sql:21-23` (extend grant list)

- [ ] **Step 1: Append the grant**

Edit `supabase/seed.sql`. After the existing `GRANT TRUNCATE ON exercises, …` block (around lines 20–23), append:

```sql
-- daily_logs is owned (writes) by gym_writer_role; allow the local-dev login to TRUNCATE.
GRANT TRUNCATE ON daily_logs TO gym_writer_user;
```

- [ ] **Step 2: Re-apply seed and verify**

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres' \
     -c 'TRUNCATE daily_logs;'
```

Expected: `TRUNCATE TABLE` with no error.

- [ ] **Step 3: Commit**

```bash
git add supabase/seed.sql
git commit -m "chore(seed): TRUNCATE grant on daily_logs for gym_writer_user"
```

---

## Task 5: TS — `health_log_day` upsert tool

**Files:**
- Create: `mcp-server/src/tools/health-log-day.ts`
- Create: `mcp-server/src/tools/health-log-day.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/src/tools/health-log-day.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../db.js';
import { healthLogDay } from './health-log-day.js';

const writePool = createPool(process.env.MCP_GYM_WRITER_URL ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE daily_logs');
});

describe('healthLogDay', () => {
  it('inserts a fresh row with the given date and fields', async () => {
    const r = await healthLogDay(writePool, {
      date: '2026-05-14', tz: 'Europe/Warsaw', alcohol: true, notes: 'urodziny'
    });
    expect(r.day).toBe('2026-05-14');
    expect(r.tz).toBe('Europe/Warsaw');
    expect(r.alcohol).toBe(true);
    expect(r.notes).toBe('urodziny');
  });

  it('defaults date to "today in tz" when date is omitted', async () => {
    const r = await healthLogDay(writePool, { tz: 'UTC', alcohol: false });
    expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.alcohol).toBe(false);
  });

  it('defaults tz to UTC when tz is omitted', async () => {
    const r = await healthLogDay(writePool, { date: '2026-05-14', alcohol: true });
    expect(r.tz).toBe('UTC');
  });

  it('upserts on (day): second call updates supplied fields, preserves others via COALESCE', async () => {
    await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', alcohol: true, notes: 'first note' });
    // Second call: only set notes; alcohol should stay true.
    const r2 = await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', notes: 'second note' });
    expect(r2.alcohol).toBe(true);          // preserved
    expect(r2.notes).toBe('second note');   // updated

    // Third call: only set alcohol; notes should stay 'second note'.
    const r3 = await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', alcohol: false });
    expect(r3.alcohol).toBe(false);
    expect(r3.notes).toBe('second note');
  });

  it('produces exactly one row per day after multiple upserts', async () => {
    await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', alcohol: true });
    await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', alcohol: false });
    await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', notes: 'x' });
    const c = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM daily_logs WHERE day = '2026-05-14'`
    );
    expect(c.rows[0].count).toBe('1');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd mcp-server && npm test -- src/tools/health-log-day.test.ts
```

Expected: vitest fails because `./health-log-day.js` does not resolve.

- [ ] **Step 3: Implement the tool**

Create `mcp-server/src/tools/health-log-day.ts`:

```ts
import type { Pool } from '../db.js';

export interface HealthLogDayInput {
  date?: string;     // YYYY-MM-DD; default = today in `tz`
  tz?: string;       // IANA tz; default = 'UTC'
  alcohol?: boolean; // undefined => leave existing value untouched on upsert
  notes?: string;    // undefined => leave existing value untouched on upsert
}

export interface HealthLogDayResult {
  day: string;       // YYYY-MM-DD
  tz: string;
  alcohol: boolean | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export async function healthLogDay(
  pool: Pool,
  input: HealthLogDayInput
): Promise<HealthLogDayResult> {
  const tz = input.tz ?? 'UTC';

  // COALESCE on EXCLUDED.<col> vs daily_logs.<col>:
  //   if the caller supplied a non-null value, EXCLUDED wins;
  //   if the caller passed undefined (→ NULL via $param), the prior value is preserved.
  // tz is always overwritten — it always has a non-null value (default 'UTC').
  const sql = `
    INSERT INTO daily_logs (day, tz, alcohol, notes)
    VALUES (
      COALESCE($1::date, (now() AT TIME ZONE $2)::date),
      $2,
      $3,
      $4
    )
    ON CONFLICT (day) DO UPDATE
       SET tz         = EXCLUDED.tz,
           alcohol    = COALESCE(EXCLUDED.alcohol, daily_logs.alcohol),
           notes      = COALESCE(EXCLUDED.notes, daily_logs.notes),
           updated_at = now()
    RETURNING to_char(day, 'YYYY-MM-DD') AS day,
              tz,
              alcohol,
              notes,
              created_at::text,
              updated_at::text
  `;
  const r = await pool.query<HealthLogDayResult>(sql, [
    input.date ?? null,
    tz,
    input.alcohol ?? null,
    input.notes ?? null
  ]);
  return r.rows[0];
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd mcp-server && npm test -- src/tools/health-log-day.test.ts
```

Expected: all five `healthLogDay` cases pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/health-log-day.ts \
        mcp-server/src/tools/health-log-day.test.ts
git commit -m "feat(mcp): health_log_day upsert tool"
```

---

## Task 6: TS — thread `without_break` through `gym_log_set`

**Files:**
- Modify: `mcp-server/src/tools/gym/sets.ts:3-18` (input type), `mcp-server/src/tools/gym/sets.ts:78-90` (INSERT)
- Modify: `mcp-server/src/tools/gym/sets.test.ts` (round-trip)

- [ ] **Step 1: Write the failing round-trip test**

Edit `mcp-server/src/tools/gym/sets.test.ts`. Inside the `describe('logSet', …)` block, append a new `it` case before the closing brace:

```ts
  it('persists without_break=true and defaults to false when omitted', async () => {
    const { ex, session_id } = await freshSession();
    const a = await logSet(writePool, {
      session_id, exercise_id: ex.row.id, set_uuid: randomUUID(), reps: 10, weight_kg: 50
    });
    const b = await logSet(writePool, {
      session_id, training_exercise_id: a.training_exercise_id, set_uuid: randomUUID(),
      reps: 8, weight_kg: 55, without_break: true
    });
    const r = await adminPool.query<{ id: number; without_break: boolean }>(
      `SELECT id, without_break FROM training_sets WHERE id IN ($1, $2) ORDER BY id`,
      [a.set_id, b.set_id]
    );
    expect(r.rows[0].without_break).toBe(false);
    expect(r.rows[1].without_break).toBe(true);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd mcp-server && npm test -- src/tools/gym/sets.test.ts
```

Expected: the new case fails because `LogSetInput` rejects `without_break` (TS compile error) **and** the column isn't written.

- [ ] **Step 3: Add `without_break` to `LogSetInput` and the INSERT**

Edit `mcp-server/src/tools/gym/sets.ts`. In the `LogSetInput` interface (lines 3–18), add the field right after `is_warmup`:

```ts
  is_warmup?: boolean;
  without_break?: boolean;
```

Then update the INSERT in `logSet` (around lines 78–90). Change the SQL and the parameter array so the column is written. The current INSERT:

```ts
    const setIns = await client.query<{ id: string }>(
      `INSERT INTO training_sets
         (uuid, training_exercise_id, set_index, reps, weight_kg, duration_seconds, distance_m, rpe, is_warmup, notes, performed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, false), $10, COALESCE($11::timestamptz, now()))
       RETURNING id`,
      [
        input.set_uuid, teId, setIndex,
        input.reps ?? null, input.weight_kg ?? null,
        input.duration_seconds ?? null, input.distance_m ?? null,
        input.rpe ?? null, input.is_warmup ?? null,
        input.notes ?? null, input.performed_at ?? null
      ]
    );
```

Becomes:

```ts
    const setIns = await client.query<{ id: string }>(
      `INSERT INTO training_sets
         (uuid, training_exercise_id, set_index, reps, weight_kg, duration_seconds, distance_m, rpe, is_warmup, without_break, notes, performed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, false), COALESCE($10, false), $11, COALESCE($12::timestamptz, now()))
       RETURNING id`,
      [
        input.set_uuid, teId, setIndex,
        input.reps ?? null, input.weight_kg ?? null,
        input.duration_seconds ?? null, input.distance_m ?? null,
        input.rpe ?? null, input.is_warmup ?? null,
        input.without_break ?? null,
        input.notes ?? null, input.performed_at ?? null
      ]
    );
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd mcp-server && npm test -- src/tools/gym/sets.test.ts
```

Expected: all `logSet` cases (including the new one) pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/gym/sets.ts \
        mcp-server/src/tools/gym/sets.test.ts
git commit -m "feat(mcp): gym_log_set accepts without_break"
```

---

## Task 7: TS — thread `without_break` through `gym_submit_session_bulk`

**Files:**
- Modify: `mcp-server/src/tools/gym/bulk.ts:4-18` (SetSchema), `mcp-server/src/tools/gym/bulk.ts:173-188` (INSERT in set loop)
- Modify: `mcp-server/src/tools/gym/bulk.test.ts` (round-trip)

- [ ] **Step 1: Write the failing round-trip test**

Edit `mcp-server/src/tools/gym/bulk.test.ts`. Append a new `it` case inside `describe('submitSessionBulk', …)`:

```ts
  it('persists without_break on bulk-imported sets', async () => {
    await adminPool.query(`INSERT INTO gyms (slug, display_name) VALUES ('fitfabric-wola', 'FitFabric Wola')`);
    await adminPool.query(`INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES ('seated-cable-row', 'Seated Cable Row', 'lats', 'cable')`);

    const payload = {
      session_uuid: '11111111-1111-1111-1111-111111111111',
      gym_slug: 'fitfabric-wola',
      type: 'pull',
      started_at: '2026-05-14T17:30:00Z',
      ended_at:   '2026-05-14T18:45:00Z',
      exercises: [{
        exercise_slug: 'seated-cable-row',
        exercise_uuid: '11111111-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        sets: [
          { set_uuid: 'b-1', reps: 10, weight_kg: 50 },                          // default false
          { set_uuid: 'b-2', reps: 8,  weight_kg: 55, without_break: true }      // explicit true
        ]
      }]
    };

    await submitSessionBulk(writePool, payload);
    const r = await adminPool.query<{ uuid: string; without_break: boolean }>(
      `SELECT uuid, without_break FROM training_sets WHERE uuid IN ('b-1', 'b-2') ORDER BY uuid`
    );
    expect(r.rows[0]).toEqual({ uuid: 'b-1', without_break: false });
    expect(r.rows[1]).toEqual({ uuid: 'b-2', without_break: true });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd mcp-server && npm test -- src/tools/gym/bulk.test.ts
```

Expected: the new case fails (Zod strips unknown `without_break` → column never written → both rows are `false`).

- [ ] **Step 3: Add `without_break` to `SetSchema` and the INSERT**

Edit `mcp-server/src/tools/gym/bulk.ts`. In `SetSchema` (lines 4–18), add the field next to `is_warmup`:

```ts
  is_warmup:        z.boolean().optional(),
  without_break:    z.boolean().optional(),
```

Then update the INSERT in `submitSessionBulk` (around lines 173–188). Change the SQL and the parameter list:

```ts
        await client.query(
          `INSERT INTO training_sets
             (uuid, training_exercise_id, set_index, reps, weight_kg,
              duration_seconds, distance_m, rpe, is_warmup, without_break, notes, performed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, false), COALESCE($10, false), $11,
                   COALESCE($12::timestamptz, $13::timestamptz))`,
          [
            st.set_uuid, teId, st.set_index ?? (j + 1),
            st.reps ?? null, st.weight_kg ?? null,
            st.duration_seconds ?? null, st.distance_m ?? null,
            st.rpe ?? null, st.is_warmup ?? null,
            st.without_break ?? null,
            st.notes ?? null, st.performed_at ?? null, payload.started_at
          ]
        );
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd mcp-server && npm test -- src/tools/gym/bulk.test.ts
```

Expected: all bulk cases pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/gym/bulk.ts \
        mcp-server/src/tools/gym/bulk.test.ts
git commit -m "feat(mcp): gym_submit_session_bulk accepts without_break"
```

---

## Task 8: TS — extend `LastExerciseRow` type with `without_break`

**Files:**
- Modify: `mcp-server/src/tools/gym/lookup.ts:39` (set shape inside `LastExerciseRow`)

- [ ] **Step 1: Add the field to the type**

Edit `mcp-server/src/tools/gym/lookup.ts`. In the `LastExerciseRow` interface, update the `sets` element type to include `without_break`:

```ts
  sets: Array<{ set_index: number; reps: number | null; weight_kg: number | null; rpe: number | null; is_warmup: boolean; without_break: boolean; notes: string | null }>;
```

- [ ] **Step 2: Typecheck and run the mcp-server suite**

```bash
cd mcp-server && npm run typecheck && npm test
```

Expected: no TS errors; all tests still pass. The runtime data already includes `without_break` (added in Task 3) — this step only adjusts the TS type so consumers see it.

- [ ] **Step 3: Commit**

```bash
git add mcp-server/src/tools/gym/lookup.ts
git commit -m "feat(mcp): LastExerciseRow.sets carries without_break"
```

---

## Task 9: MCP server wiring — register tool, extend two zod schemas, extend e2e test

**Files:**
- Modify: `mcp-server/src/index.ts:16-18` (import), `mcp-server/src/index.ts:134-164` (gym_log_set + gym_submit_session_bulk zod schemas), `mcp-server/src/index.ts:217-219` (register `health_log_day`)
- Modify: `mcp-server/src/index.test.ts:60-74` (expect new tool in tools/list)

- [ ] **Step 1: Extend the e2e test (failing first)**

Edit `mcp-server/src/index.test.ts`. Inside the second `it` block, append one more expectation in the tools/list assertions:

```ts
    expect(text).toMatch(/health_log_day/);
```

- [ ] **Step 2: Run the e2e test to verify it fails**

```bash
cd mcp-server && npm test -- src/index.test.ts
```

Expected: tools/list assertion for `health_log_day` fails (not registered yet).

- [ ] **Step 3: Import the new tool**

Edit `mcp-server/src/index.ts`. After the existing `import { logSet, addNote } …` line (~line 16), add:

```ts
import { healthLogDay } from './tools/health-log-day.js';
```

- [ ] **Step 4: Register the new tool against `writePool`**

In `buildMcp`, after the `gym_submit_session_bulk` registration block (around line 215, just before `return server;`), add:

```ts
  // --- Daily lifestyle log -------------------------------------------
  server.registerTool('health_log_day',
    { description: 'Upsert today\'s lifestyle log (alcohol y/n, free-text notes). One row per local day. Omitted fields are preserved on update.',
      inputSchema: z.object({
        date:    z.string().optional(),
        tz:      z.string().optional(),
        alcohol: z.boolean().optional(),
        notes:   z.string().optional()
      }) },
    async (i) => text(await healthLogDay(writePool, i))
  );
```

- [ ] **Step 5: Extend the `gym_log_set` zod schema to accept `without_break`**

In the `gym_log_set` registration (around lines 135–154), add `without_break` to the schema. Change:

```ts
        is_warmup: z.boolean().optional(),
        notes: z.string().optional(),
```

to:

```ts
        is_warmup: z.boolean().optional(),
        without_break: z.boolean().optional(),
        notes: z.string().optional(),
```

- [ ] **Step 6: Extend the `gym_submit_session_bulk` zod schema to accept `without_break` on each set**

In the inline `sets:` schema inside `gym_submit_session_bulk` (around lines 200–212), add:

```ts
            is_warmup:        z.boolean().optional(),
            without_break:    z.boolean().optional(),
            notes:            z.string().nullable().optional(),
```

- [ ] **Step 7: Run the full mcp-server suite to verify**

```bash
cd mcp-server && npm test
```

Expected: every suite passes, including the e2e `tools/list` matching `health_log_day`.

- [ ] **Step 8: Commit**

```bash
git add mcp-server/src/index.ts mcp-server/src/index.test.ts
git commit -m "feat(mcp): register health_log_day; thread without_break in schemas"
```

---

## Task 10: Schema resource — list `daily_logs`, document `without_break`

**Files:**
- Modify: `mcp-server/src/resources/schema.ts:7-15` (allowlist), `mcp-server/src/resources/schema.ts:44-114` (prose + example)
- Modify: `mcp-server/src/resources/schema.test.ts` (new assertions)

- [ ] **Step 1: Extend the schema-resource test (failing first)**

Edit `mcp-server/src/resources/schema.test.ts`. Append a new `it` block to the existing `describe('describeSchema', …)`:

```ts
  it('lists daily_logs and exposes the without_break column on training_sets', async () => {
    const md = await describeSchema(pool);
    expect(md).toMatch(/daily_logs/);
    expect(md).toMatch(/`alcohol`/);
    expect(md).toMatch(/`without_break`/);
    expect(md).toMatch(/health_log_day/);  // mentioned in the prose section
  });
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd mcp-server && npm test -- src/resources/schema.test.ts
```

Expected: the new case fails — `daily_logs` is not in the introspection allowlist and the prose doesn't mention it.

- [ ] **Step 3: Add `daily_logs` to the introspection allowlist**

Edit `mcp-server/src/resources/schema.ts`. In the introspection query (lines 7–15), add `'daily_logs'` to the `IN (…)` list:

```ts
  const cols = await pool.query<ColumnRow>(`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('health_samples','device_state','summary_cache','daily_logs',
                   'exercises','gyms','gym_machines',
                   'training_sessions','training_exercises','training_sets')
     ORDER BY table_name, ordinal_position
  `);
```

- [ ] **Step 4: Add a prose section + example query**

Still in `mcp-server/src/resources/schema.ts`, find the final return block (`return [ … ]`). After the closing of the existing "Gym example queries" code-fence (the line `'```'` at the bottom around line 113), add a new section before the closing `].join('\n')`. Replace:

```ts
    '```'
  ].join('\n');
```

with:

```ts
    '```',
    '',
    '## Daily lifestyle log',
    '',
    '`daily_logs` — one row per local day. `day` is the local date in `tz`. `alcohol` is `NULL` until logged, then `true` / `false`. `notes` is last-write-wins. Upsert via the `health_log_day` MCP tool; `run_sql` is read-only on this table.',
    '',
    '## Training-set continuity',
    '',
    '`training_sets.without_break = true` marks a set performed immediately after the previous one with no rest (drop set, rest-pause, "one more"). Default `false`. Combine with decreasing `weight_kg` in a query to identify drop sets specifically.',
    '',
    '## Daily-log example queries',
    '',
    '```sql',
    '-- alcohol days in the last 30, with HRV the next morning',
    'SELECT dl.day, dl.alcohol,',
    "       AVG(hs.value) FILTER (WHERE hs.data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN') AS hrv_next_morning",
    '  FROM daily_logs dl',
    "  LEFT JOIN health_samples hs ON hs.deleted_at IS NULL",
    "   AND (hs.start_date AT TIME ZONE dl.tz)::date = dl.day + INTERVAL '1 day'",
    " WHERE dl.day >= current_date - INTERVAL '30 days'",
    ' GROUP BY dl.day, dl.alcohol',
    ' ORDER BY dl.day DESC;',
    '```'
  ].join('\n');
```

- [ ] **Step 5: Run the full mcp-server suite to verify**

```bash
cd mcp-server && npm test
```

Expected: every suite passes, including the new schema-resource assertions.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/resources/schema.ts mcp-server/src/resources/schema.test.ts
git commit -m "feat(mcp): schema resource lists daily_logs and without_break"
```

---

## Task 11: Final verification across the whole stack

**Files:** none (verification only).

- [ ] **Step 1: Reset DB and run every SQL test**

```bash
cd supabase && supabase db reset && cd ..
for t in supabase/tests/*.test.sql; do
  psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f "$t" || exit 1
done
```

Expected: every test file ends with `NOTICE:  *.test.sql OK`. No `ERROR:` lines.

- [ ] **Step 2: Run the full mcp-server suite**

```bash
cd mcp-server && npm run typecheck && npm test
```

Expected: `typecheck` exits zero; all vitest suites pass — including `health-log-day.test.ts`, `gym/sets.test.ts`, `gym/bulk.test.ts`, `index.test.ts`, and `resources/schema.test.ts`.

- [ ] **Step 3: Run the Edge Function tests (unchanged surface, sanity check)**

```bash
cd supabase/functions/ingest && deno test --allow-env --allow-net --allow-read && cd ../../..
```

Expected: all `deno test` cases pass — these aren't supposed to regress, but the Edge Function shares the database so the check is cheap.

- [ ] **Step 4: Confirm rollback safety (manual reasoning, no command)**

Open each new migration file and verify:

- `20260514000000_daily_logs.sql` — `CREATE TABLE IF NOT EXISTS` + idempotent `GRANT`s; old MCP image doesn't reference this table → safe.
- `20260514000100_training_sets_without_break.sql` — `ADD COLUMN IF NOT EXISTS … NOT NULL DEFAULT false`; old INSERTs without the column still satisfy the constraint → safe.
- `20260514000200_last_exercise_results_v2.sql` — `CREATE OR REPLACE FUNCTION` with the **same signature**; old MCP code reads the JSON and only consumes known keys → safe.

If any of these is violated, fix it before committing. If they all hold, no action needed.

---

## Self-review

**Spec coverage:**
- `daily_logs` table — Task 1 ✓
- `gym_writer_role` widened to write `daily_logs` — Task 1 grants ✓
- `health_read_role` SELECT — Task 1 grants ✓
- `health_log_day` upsert tool with COALESCE semantics — Task 5 ✓
- Tool wired against `writePool` (no new env var/pool) — Task 9 ✓
- `without_break` column on `training_sets`, NOT NULL DEFAULT false — Task 2 ✓
- `without_break` in `gym_log_set` — Task 6 (lib) + Task 9 (zod) ✓
- `without_break` in `gym_submit_session_bulk` — Task 7 (lib) + Task 9 (zod) ✓
- `without_break` in `last_exercise_results` JSONB — Task 3 ✓
- `LastExerciseRow` TS type carries `without_break` — Task 8 ✓
- Schema resource lists `daily_logs` and documents `without_break` — Task 10 ✓
- SQL tests: `daily_logs_schema`, `daily_logs_roles`, extended `gym_schema`, extended `gym_helpers` — Tasks 1, 2, 3 ✓
- TS tests: `health-log-day`, extended `sets`, extended `bulk`, extended `schema`, extended `index` (e2e) — Tasks 5, 6, 7, 9, 10 ✓
- Seed TRUNCATE grant — Task 4 ✓
- Three separate migrations — Tasks 1, 2, 3 ✓
- No deploy/install/upgrade changes — confirmed (no Task references those files)

**Placeholder scan:** No TBDs, TODOs, "implement later", or hand-wave steps. Every code-bearing step shows the actual code. Every command shows the expected output shape.

**Type / name consistency:**
- Function name: `healthLogDay` (TS) vs MCP tool name `health_log_day` (kebab→snake by convention) — consistent throughout Tasks 5 and 9.
- `LogSetInput.without_break` (Task 6) matches `SetSchema.without_break` in bulk (Task 7) matches `training_sets.without_break` column (Task 2) matches JSON key `without_break` (Task 3) matches zod field name in `index.ts` (Task 9). All five spellings agree.
- `LastExerciseRow.sets[].without_break: boolean` (Task 8) is non-nullable, matching the column's `NOT NULL DEFAULT false`.
- Migration filenames in chronological order: `…000000` < `…000100` < `…000200`, matching the existing repo convention.

---

## Execution

**Plan complete and saved to `docs/superpowers/plans/2026-05-14-daily-log-and-without-break.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
