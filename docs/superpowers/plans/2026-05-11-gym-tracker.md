# Gym Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a gym/training tracker to `oc-health-sync` — six new Postgres tables, 14 MCP tools (8 write + 6 read), and a `gym-coach` skill — sharing the existing infra so cross-domain SQL joins with `health_samples` stay one query away. (The spec mentions "13" tools; the actual count is 14 — search/create for each of exercises, gyms, machines = 6, plus start/current/finish session = 3, log_set + add_note = 2, last_session_summary + last_exercise_results = 2, submit_session_bulk = 1.)

**Architecture:** New tables in `public` schema, additive migrations only. MCP server gains a second connection pool backed by a new `gym_writer_role` (NOLOGIN, matches the existing `health_*_role` pattern) so write tools can never touch HealthKit tables. Idempotency via client-generated UUIDs on sessions and sets (same pattern as `health_samples.uuid`). Open-session lifecycle enforced in DB via a partial-unique index. Catalog discipline lives in the `gym-coach` skill — server doesn't fuzzy-merge.

**Tech Stack:** Postgres 15 (Supabase self-hosted), Node 24 + TypeScript, `@modelcontextprotocol/{server,express,node}@2.0.0-alpha.2`, `pg`, `zod@^4`, `vitest`.

---

## Spec deviation (deliberate)

The spec describes a single `gym_writer` role with LOGIN. The existing repo pattern is **two-layer**: a NOLOGIN role with grants (in a migration) and a LOGIN user that inherits from it (in `seed.sql` for local dev, in deploy `init-users.sh` for prod). The plan follows the repo pattern: `gym_writer_role` (NOLOGIN, migration) + `gym_writer_user` (LOGIN, seed.sql). The env var stays `MCP_GYM_WRITER_URL` per the spec.

## File map

**New files**

| Path | Purpose |
|---|---|
| `supabase/migrations/20260511000000_init_gym_tables.sql` | Tables, indexes, helpers, view |
| `supabase/migrations/20260511000100_gym_roles.sql` | `gym_writer_role` (NOLOGIN) + grants on new tables for both roles |
| `supabase/tests/gym_schema.test.sql` | Table shape, constraints, partial-unique open-session index |
| `supabase/tests/gym_helpers.test.sql` | `last_sessions_by_type` + `last_exercise_results` on fixtures |
| `supabase/tests/gym_roles.test.sql` | Privilege assertions for `gym_writer_role` and `health_read_role` |
| `mcp-server/src/tools/gym/catalog.ts` | search + create for exercises, gyms, machines |
| `mcp-server/src/tools/gym/catalog.test.ts` | Catalog tool tests |
| `mcp-server/src/tools/gym/session.ts` | `start_session`, `current_session`, `finish_session` |
| `mcp-server/src/tools/gym/session.test.ts` | Session lifecycle tests |
| `mcp-server/src/tools/gym/sets.ts` | `log_set`, `add_note` |
| `mcp-server/src/tools/gym/sets.test.ts` | Set logging tests, including idempotency |
| `mcp-server/src/tools/gym/lookup.ts` | `last_session_summary`, `last_exercise_results` |
| `mcp-server/src/tools/gym/lookup.test.ts` | Comparison-helper tests |
| `mcp-server/src/tools/gym/bulk.ts` | `submit_session_bulk` + Zod payload schema |
| `mcp-server/src/tools/gym/bulk.test.ts` | Bulk-import happy path + unknown-slug rejection |
| `mcp-server/test/fixtures/bulk-session.json` | Golden file for bulk-import e2e |
| `skill_example/gym-coach/SKILL.md` | The gym-coach skill |

**Modified files**

| Path | Change |
|---|---|
| `supabase/seed.sql` | Add `gym_writer_user` LOGIN role + local TRUNCATE grant |
| `mcp-server/src/db.ts` | (no API change — already exports `createPool`/`Pool`) |
| `mcp-server/src/index.ts` | Create second pool from `MCP_GYM_WRITER_URL`; pass into `buildMcp`; register 13 new tools |
| `mcp-server/src/index.test.ts` | Set `MCP_GYM_WRITER_URL`; assert new tool names appear in `tools/list` |
| `mcp-server/src/resources/schema.ts` | Append "Gym tables" section + example queries |
| `mcp-server/src/resources/schema.test.ts` | Assert new sections appear |
| `deploy/docker-compose.mcp.yml` | Add `MCP_GYM_WRITER_URL` env on `mcp` service |
| `deploy/install.sh` | Provision `gym_writer_user` + bake `MCP_GYM_WRITER_URL` into `.env` (matches existing `read_user`/`ingest_user` provisioning) |
| `README.md` | Document the gym MCP surface |
| `CONTRIBUTING.md` | Note the new test files in the "Local development" loop |

---

## Pre-flight

Always run before tests:

```bash
cd supabase && supabase db reset && cd ..
```

This applies migrations + seed in order — required for the MCP and SQL tests to start from a clean baseline.

---

## Task 1: Migration — gym tables, indexes, helper functions, view

**Files:**
- Create: `supabase/migrations/20260511000000_init_gym_tables.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Gym tracker: exercises catalog, gyms catalog, per-gym machines,
-- and session/exercise/set hierarchy. All soft-deleted via deleted_at.
-- Idempotent (CREATE … IF NOT EXISTS / CREATE OR REPLACE) per repo policy.

CREATE TABLE IF NOT EXISTS exercises (
  id                BIGSERIAL PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  primary_muscle    TEXT NOT NULL,
  secondary_muscles TEXT[] NOT NULL DEFAULT '{}',
  mechanic          TEXT,
  equipment_class   TEXT NOT NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gyms (
  id           BIGSERIAL PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  city         TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gym_machines (
  id            BIGSERIAL PRIMARY KEY,
  gym_id        BIGINT NOT NULL REFERENCES gyms(id),
  exercise_id   BIGINT NOT NULL REFERENCES exercises(id),
  manufacturer  TEXT,
  model         TEXT,
  label         TEXT,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ
);
-- NULLs differ in plain UNIQUE; use a NULL-safe expression for the dedupe key.
CREATE UNIQUE INDEX IF NOT EXISTS uq_gym_machines_identity
  ON gym_machines (
    gym_id,
    exercise_id,
    COALESCE(manufacturer, ''),
    COALESCE(model, '')
  )
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS training_sessions (
  id          BIGSERIAL PRIMARY KEY,
  uuid        TEXT NOT NULL UNIQUE,
  gym_id      BIGINT NOT NULL REFERENCES gyms(id),
  type        TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,
  rating      SMALLINT,
  notes       TEXT,
  source      TEXT NOT NULL DEFAULT 'live',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT training_sessions_rating_chk   CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
  CONSTRAINT training_sessions_temporal_chk CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT training_sessions_type_chk     CHECK (type IN ('push','pull','legs','upper','lower','full','cardio','mobility','other')),
  CONSTRAINT training_sessions_source_chk   CHECK (source IN ('live','bulk'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_gym_type_started
  ON training_sessions (gym_id, type, started_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sessions_type_started
  ON training_sessions (type, started_at DESC)
  WHERE deleted_at IS NULL;
-- At most one open session at a time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_open_session
  ON training_sessions ((true))
  WHERE deleted_at IS NULL AND ended_at IS NULL;

CREATE TABLE IF NOT EXISTS training_exercises (
  id              BIGSERIAL PRIMARY KEY,
  uuid            TEXT NOT NULL UNIQUE,
  session_id      BIGINT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  exercise_id     BIGINT NOT NULL REFERENCES exercises(id),
  gym_machine_id  BIGINT REFERENCES gym_machines(id),
  position        INTEGER NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_te_session  ON training_exercises (session_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_te_exercise ON training_exercises (exercise_id) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_te_session_position
  ON training_exercises (session_id, position)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS training_sets (
  id                    BIGSERIAL PRIMARY KEY,
  uuid                  TEXT NOT NULL UNIQUE,
  training_exercise_id  BIGINT NOT NULL REFERENCES training_exercises(id) ON DELETE CASCADE,
  set_index             INTEGER NOT NULL,
  reps                  INTEGER,
  weight_kg             DOUBLE PRECISION,
  duration_seconds      DOUBLE PRECISION,
  distance_m            DOUBLE PRECISION,
  rpe                   SMALLINT,
  is_warmup             BOOLEAN NOT NULL DEFAULT false,
  notes                 TEXT,
  performed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  CONSTRAINT training_sets_rpe_chk     CHECK (rpe IS NULL OR rpe BETWEEN 1 AND 10),
  CONSTRAINT training_sets_measure_chk CHECK (reps IS NOT NULL OR duration_seconds IS NOT NULL OR distance_m IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_sets_te_idx
  ON training_sets (training_exercise_id, set_index)
  WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ts_exercise_setindex
  ON training_sets (training_exercise_id, set_index)
  WHERE deleted_at IS NULL;

-- Helpers ---------------------------------------------------------------

CREATE OR REPLACE FUNCTION last_sessions_by_type(
  p_type   TEXT,
  p_gym_id BIGINT
) RETURNS TABLE (
  session_id      BIGINT,
  gym_id          BIGINT,
  gym_slug        TEXT,
  same_gym        BOOLEAN,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  rating          SMALLINT,
  total_sets      BIGINT,
  total_volume_kg DOUBLE PRECISION,
  top_set         JSONB
) LANGUAGE sql STABLE AS $$
  WITH finalized AS (
    SELECT s.id, s.gym_id, g.slug AS gym_slug,
           (s.gym_id = p_gym_id) AS same_gym,
           s.started_at, s.ended_at, s.rating
      FROM training_sessions s
      JOIN gyms g ON g.id = s.gym_id
     WHERE s.deleted_at IS NULL
       AND s.ended_at  IS NOT NULL
       AND s.type      = p_type
  ),
  ranked AS (
    SELECT f.*,
           ROW_NUMBER() OVER (PARTITION BY f.same_gym ORDER BY f.started_at DESC) AS rn
      FROM finalized f
  ),
  picked AS (
    SELECT * FROM ranked WHERE rn = 1
  ),
  agg AS (
    SELECT p.session_id_alias AS session_id,
           COUNT(ts.id)                                    AS total_sets,
           COALESCE(SUM(ts.weight_kg * ts.reps), 0)::float8 AS total_volume_kg,
           (
             SELECT to_jsonb(top)
               FROM (
                 SELECT ex.slug    AS exercise,
                        ts2.reps,
                        ts2.weight_kg
                   FROM training_sets ts2
                   JOIN training_exercises te2 ON te2.id = ts2.training_exercise_id
                   JOIN exercises ex            ON ex.id = te2.exercise_id
                  WHERE te2.session_id   = p.session_id_alias
                    AND ts2.deleted_at IS NULL
                    AND te2.deleted_at IS NULL
                    AND ts2.weight_kg  IS NOT NULL
                    AND ts2.reps       IS NOT NULL
                  ORDER BY (ts2.weight_kg * ts2.reps) DESC NULLS LAST
                  LIMIT 1
               ) top
           )                                                AS top_set
      FROM (SELECT id AS session_id_alias FROM picked) p
      LEFT JOIN training_exercises te ON te.session_id = p.session_id_alias AND te.deleted_at IS NULL
      LEFT JOIN training_sets ts      ON ts.training_exercise_id = te.id    AND ts.deleted_at IS NULL
     GROUP BY p.session_id_alias
  )
  SELECT picked.id          AS session_id,
         picked.gym_id,
         picked.gym_slug,
         picked.same_gym,
         picked.started_at,
         picked.ended_at,
         picked.rating,
         COALESCE(agg.total_sets, 0)         AS total_sets,
         COALESCE(agg.total_volume_kg, 0)    AS total_volume_kg,
         agg.top_set
    FROM picked
    LEFT JOIN agg ON agg.session_id = picked.id
   ORDER BY picked.same_gym DESC;
$$;

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
                   'set_index', ts.set_index,
                   'reps',      ts.reps,
                   'weight_kg', ts.weight_kg,
                   'rpe',       ts.rpe,
                   'is_warmup', ts.is_warmup,
                   'notes',     ts.notes
                 ) ORDER BY ts.set_index), '[]'::jsonb)
             FROM training_sets ts
            WHERE ts.training_exercise_id = r.training_exercise_id
              AND ts.deleted_at IS NULL
         ) AS sets
    FROM ranked r
   WHERE r.rn = 1
   ORDER BY r.same_gym DESC;
$$;

CREATE OR REPLACE VIEW current_open_session AS
  SELECT * FROM training_sessions
   WHERE deleted_at IS NULL AND ended_at IS NULL;
```

- [ ] **Step 2: Apply migration and verify clean reset succeeds**

Run: `cd supabase && supabase db reset && cd ..`
Expected: ends with `Finished supabase db reset on branch ...` and no error lines. If it fails, fix the SQL before continuing — every following task assumes a clean DB reset works.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260511000000_init_gym_tables.sql
git commit -m "feat(gym): add gym tracker tables, indexes, helpers, view"
```

---

## Task 2: Migration — gym roles + grants

**Files:**
- Create: `supabase/migrations/20260511000100_gym_roles.sql`

- [ ] **Step 1: Write the migration file**

```sql
-- Gym writer role: INSERT/UPDATE/SELECT on gym tables only; cannot touch health_samples.
-- Matches the existing two-layer pattern (NOLOGIN role + LOGIN user in seed.sql).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gym_writer_role') THEN
    CREATE ROLE gym_writer_role NOLOGIN;
  END IF;
END $$;

-- gym_writer_role: write + read on all gym tables.
GRANT INSERT, UPDATE, SELECT ON exercises          TO gym_writer_role;
GRANT INSERT, UPDATE, SELECT ON gyms               TO gym_writer_role;
GRANT INSERT, UPDATE, SELECT ON gym_machines       TO gym_writer_role;
GRANT INSERT, UPDATE, SELECT ON training_sessions  TO gym_writer_role;
GRANT INSERT, UPDATE, SELECT ON training_exercises TO gym_writer_role;
GRANT INSERT, UPDATE, SELECT ON training_sets      TO gym_writer_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gym_writer_role;

-- gym_writer_role must NOT touch health tables — explicit revoke as a defense
-- in case ALTER DEFAULT PRIVILEGES ever changes.
REVOKE ALL ON health_samples FROM gym_writer_role;
REVOKE ALL ON device_state   FROM gym_writer_role;
REVOKE ALL ON summary_cache  FROM gym_writer_role;

-- health_read_role: SELECT on gym tables so run_sql works on them.
GRANT SELECT ON exercises          TO health_read_role;
GRANT SELECT ON gyms               TO health_read_role;
GRANT SELECT ON gym_machines       TO health_read_role;
GRANT SELECT ON training_sessions  TO health_read_role;
GRANT SELECT ON training_exercises TO health_read_role;
GRANT SELECT ON training_sets      TO health_read_role;
GRANT SELECT ON current_open_session TO health_read_role;

-- Helpers
GRANT EXECUTE ON FUNCTION last_sessions_by_type(TEXT, BIGINT) TO health_read_role, gym_writer_role;
GRANT EXECUTE ON FUNCTION last_exercise_results(BIGINT, BIGINT) TO health_read_role, gym_writer_role;
```

- [ ] **Step 2: Modify `supabase/seed.sql` to add the local-dev gym writer user**

Open `supabase/seed.sql` and append:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gym_writer_user') THEN
    CREATE ROLE gym_writer_user LOGIN PASSWORD 'gym_writer_pw' IN ROLE gym_writer_role;
  END IF;
END $$;

-- Local-dev convenience: allow gym_writer_user to TRUNCATE gym tables for tests.
GRANT TRUNCATE ON exercises, gyms, gym_machines,
                  training_sessions, training_exercises, training_sets
  TO gym_writer_user;
```

- [ ] **Step 3: Apply and verify**

Run: `cd supabase && supabase db reset && cd ..`
Expected: clean reset; no errors.

Run:
```bash
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' \
  -c "SELECT has_table_privilege('gym_writer_role', 'public.health_samples', 'INSERT');"
```
Expected: `f` (gym_writer_role cannot write health_samples).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260511000100_gym_roles.sql supabase/seed.sql
git commit -m "feat(gym): add gym_writer_role + local gym_writer_user"
```

---

## Task 3: Schema test — table shape, constraints, partial-unique open session

**Files:**
- Create: `supabase/tests/gym_schema.test.sql`

- [ ] **Step 1: Write the test**

```sql
-- Verify constraints and the "at most one open session" invariant.
TRUNCATE training_sets, training_exercises, training_sessions,
         gym_machines, exercises, gyms RESTART IDENTITY CASCADE;

INSERT INTO gyms (slug, display_name) VALUES ('fitfabric-wola', 'FitFabric Wola');
INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class)
  VALUES ('bench-press', 'Bench Press', 'chest', 'barbell');

DO $$
DECLARE
  gym_id_v       BIGINT;
  ex_id          BIGINT;
  s1_id          BIGINT;
  te_id          BIGINT;
BEGIN
  SELECT id INTO gym_id_v FROM gyms WHERE slug = 'fitfabric-wola';
  SELECT id INTO ex_id    FROM exercises WHERE slug = 'bench-press';

  -- 1. CHECK: rating must be 1..10
  BEGIN
    INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating)
      VALUES ('s-bad-rating', gym_id_v, 'push', now(), now(), 11);
    RAISE EXCEPTION 'expected rating CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 2. CHECK: type must be one of the allowed slugs
  BEGIN
    INSERT INTO training_sessions (uuid, gym_id, type, started_at)
      VALUES ('s-bad-type', gym_id_v, 'arms', now());
    RAISE EXCEPTION 'expected type CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. Partial-unique index: only one open session allowed
  INSERT INTO training_sessions (uuid, gym_id, type, started_at)
    VALUES ('s-open-1', gym_id_v, 'push', now()) RETURNING id INTO s1_id;

  BEGIN
    INSERT INTO training_sessions (uuid, gym_id, type, started_at)
      VALUES ('s-open-2', gym_id_v, 'pull', now());
    RAISE EXCEPTION 'expected unique open-session violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Close the first; second should now insert fine
  UPDATE training_sessions SET ended_at = now() WHERE id = s1_id;
  INSERT INTO training_sessions (uuid, gym_id, type, started_at)
    VALUES ('s-open-2', gym_id_v, 'pull', now());

  -- 4. CHECK: training_sets must have at least one measurement
  INSERT INTO training_exercises (uuid, session_id, exercise_id, position)
    VALUES ('te-1', s1_id, ex_id, 1) RETURNING id INTO te_id;

  BEGIN
    INSERT INTO training_sets (uuid, training_exercise_id, set_index)
      VALUES ('st-empty', te_id, 1);
    RAISE EXCEPTION 'expected measurement CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- a reps-only set is fine
  INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps)
    VALUES ('st-ok', te_id, 1, 10);

  -- 5. gym_machines NULL-safe uniqueness
  INSERT INTO gym_machines (gym_id, exercise_id, manufacturer, model)
    VALUES (gym_id_v, ex_id, NULL, NULL);
  BEGIN
    INSERT INTO gym_machines (gym_id, exercise_id, manufacturer, model)
      VALUES (gym_id_v, ex_id, NULL, NULL);
    RAISE EXCEPTION 'expected gym_machines NULL-safe unique violation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  RAISE NOTICE 'gym_schema.test.sql OK';
END $$;

TRUNCATE training_sets, training_exercises, training_sessions,
         gym_machines, exercises, gyms RESTART IDENTITY CASCADE;
```

- [ ] **Step 2: Run it**

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_schema.test.sql
```

Expected output ends with: `NOTICE:  gym_schema.test.sql OK`. Any other error fails the task.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/gym_schema.test.sql
git commit -m "test(gym): schema constraints and open-session invariant"
```

---

## Task 4: Schema test — gym roles

**Files:**
- Create: `supabase/tests/gym_roles.test.sql`

- [ ] **Step 1: Write the test**

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gym_writer_role') THEN
    RAISE EXCEPTION 'gym_writer_role missing';
  END IF;

  IF NOT has_table_privilege('gym_writer_role', 'public.training_sets', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role missing INSERT on training_sets';
  END IF;

  IF has_table_privilege('gym_writer_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role should NOT have INSERT on health_samples';
  END IF;
  IF has_table_privilege('gym_writer_role', 'public.health_samples', 'SELECT') THEN
    RAISE EXCEPTION 'gym_writer_role should NOT have SELECT on health_samples';
  END IF;

  IF NOT has_table_privilege('health_read_role', 'public.training_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'health_read_role missing SELECT on training_sessions';
  END IF;
  IF has_table_privilege('health_read_role', 'public.training_sessions', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role should NOT have INSERT on training_sessions';
  END IF;

  RAISE NOTICE 'gym_roles.test.sql OK';
END $$;
```

- [ ] **Step 2: Run**

```bash
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_roles.test.sql
```

Expected ends with: `NOTICE:  gym_roles.test.sql OK`.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/gym_roles.test.sql
git commit -m "test(gym): role privilege assertions"
```

---

## Task 5: Schema test — helper functions

**Files:**
- Create: `supabase/tests/gym_helpers.test.sql`

- [ ] **Step 1: Write the test**

```sql
TRUNCATE training_sets, training_exercises, training_sessions,
         gym_machines, exercises, gyms RESTART IDENTITY CASCADE;

INSERT INTO gyms (slug, display_name) VALUES
  ('fitfabric-wola', 'FitFabric Wola'),
  ('precor-mokotow', 'Precor Mokotów');
INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class)
  VALUES ('seated-cable-row', 'Seated Cable Row', 'lats', 'cable');

DO $$
DECLARE
  gym_wola_id     BIGINT;
  gym_mokotow_id  BIGINT;
  ex_id           BIGINT;
  s_old_wola_id   BIGINT;
  s_recent_mok_id BIGINT;
  te_old          BIGINT;
  te_recent       BIGINT;
  r RECORD;
  rows_seen       INT := 0;
BEGIN
  SELECT id INTO gym_wola_id    FROM gyms WHERE slug = 'fitfabric-wola';
  SELECT id INTO gym_mokotow_id FROM gyms WHERE slug = 'precor-mokotow';
  SELECT id INTO ex_id          FROM exercises WHERE slug = 'seated-cable-row';

  -- Older session at Wola (same gym, older)
  INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating)
    VALUES ('s-wola-old', gym_wola_id, 'pull', '2026-04-15T17:00:00Z', '2026-04-15T18:00:00Z', 6)
    RETURNING id INTO s_old_wola_id;
  INSERT INTO training_exercises (uuid, session_id, exercise_id, position)
    VALUES ('te-wola-old', s_old_wola_id, ex_id, 1) RETURNING id INTO te_old;
  INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg, rpe)
    VALUES ('st-wola-old-1', te_old, 1, 10, 50, 7),
           ('st-wola-old-2', te_old, 2, 10, 55, 8);

  -- More recent session at Mokotów (other gym)
  INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating)
    VALUES ('s-mok-recent', gym_mokotow_id, 'pull', '2026-05-08T17:00:00Z', '2026-05-08T18:00:00Z', 8)
    RETURNING id INTO s_recent_mok_id;
  INSERT INTO training_exercises (uuid, session_id, exercise_id, position)
    VALUES ('te-mok-recent', s_recent_mok_id, ex_id, 1) RETURNING id INTO te_recent;
  INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg, rpe)
    VALUES ('st-mok-1', te_recent, 1, 10, 60, 8);

  -- last_sessions_by_type from the perspective of Wola
  FOR r IN
    SELECT * FROM last_sessions_by_type('pull', gym_wola_id) ORDER BY same_gym DESC
  LOOP
    rows_seen := rows_seen + 1;
    IF rows_seen = 1 THEN
      IF NOT r.same_gym THEN RAISE EXCEPTION 'first row should be same_gym'; END IF;
      IF r.session_id IS DISTINCT FROM s_old_wola_id THEN
        RAISE EXCEPTION 'expected old Wola session as same-gym, got %', r.session_id;
      END IF;
      IF r.total_sets IS DISTINCT FROM 2 THEN
        RAISE EXCEPTION 'expected total_sets=2, got %', r.total_sets;
      END IF;
    ELSIF rows_seen = 2 THEN
      IF r.same_gym THEN RAISE EXCEPTION 'second row should be other-gym'; END IF;
      IF r.session_id IS DISTINCT FROM s_recent_mok_id THEN
        RAISE EXCEPTION 'expected Mokotów session as other-gym, got %', r.session_id;
      END IF;
    END IF;
  END LOOP;
  IF rows_seen <> 2 THEN RAISE EXCEPTION 'expected 2 rows from last_sessions_by_type, got %', rows_seen; END IF;

  -- last_exercise_results from the perspective of Wola
  rows_seen := 0;
  FOR r IN
    SELECT * FROM last_exercise_results(ex_id, gym_wola_id) ORDER BY same_gym DESC
  LOOP
    rows_seen := rows_seen + 1;
    IF rows_seen = 1 THEN
      IF NOT r.same_gym THEN RAISE EXCEPTION 'first row should be same_gym'; END IF;
      IF jsonb_array_length(r.sets) <> 2 THEN
        RAISE EXCEPTION 'expected 2 sets on same-gym row, got %', jsonb_array_length(r.sets);
      END IF;
    ELSIF rows_seen = 2 THEN
      IF r.same_gym THEN RAISE EXCEPTION 'second row should be other-gym'; END IF;
    END IF;
  END LOOP;
  IF rows_seen <> 2 THEN RAISE EXCEPTION 'expected 2 rows from last_exercise_results, got %', rows_seen; END IF;

  RAISE NOTICE 'gym_helpers.test.sql OK';
END $$;

TRUNCATE training_sets, training_exercises, training_sessions,
         gym_machines, exercises, gyms RESTART IDENTITY CASCADE;
```

- [ ] **Step 2: Run**

```bash
cd supabase && supabase db reset && cd ..
psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f supabase/tests/gym_helpers.test.sql
```

Expected ends with: `NOTICE:  gym_helpers.test.sql OK`.

- [ ] **Step 3: Commit**

```bash
git add supabase/tests/gym_helpers.test.sql
git commit -m "test(gym): helper functions return same-gym and other-gym rows"
```

---

## Task 6: MCP server — second pool wiring + writePool prep

**Files:**
- Modify: `mcp-server/src/index.ts`

The DB layer doesn't need changes — `createPool(dsn)` already does what we need. We add a second `createPool` call in `startServer` and make `buildMcp` take both pools.

- [ ] **Step 1: Edit `mcp-server/src/index.ts`**

Change `buildMcp(pool: Pool)` to `buildMcp(readPool: Pool, writePool: Pool)`, rename existing `pool` references inside it to `readPool`, and pass both pools through. Update `startServer`:

Replace lines around the existing `function buildMcp(pool: Pool): McpServer {` signature with:

```ts
function buildMcp(readPool: Pool, writePool: Pool): McpServer {
  const server = new McpServer({ name: 'oc-health-sync', version: '0.1.0' });
  // (existing health_* + run_sql registrations use readPool — rename pool → readPool)
  // Gym tool registrations will be appended in Task 14.
  ...
}
```

Update inside `startServer`:

```ts
export async function startServer(requestedPort: number): Promise<ServerHandle> {
  const readDsn  = process.env.MCP_DATABASE_URL;
  const writeDsn = process.env.MCP_GYM_WRITER_URL;
  if (!readDsn)  throw new Error('MCP_DATABASE_URL is not set');
  if (!writeDsn) throw new Error('MCP_GYM_WRITER_URL is not set');
  const readPool  = createPool(readDsn);
  const writePool = createPool(writeDsn);
  // ...
  // in the per-session block: buildMcp(readPool, writePool)
  // in close(): await readPool.end(); await writePool.end();
```

- [ ] **Step 2: Update `mcp-server/src/index.test.ts`**

Add the env var before `startServer`:

```ts
process.env.MCP_API_KEY = 'mcp-test-key';
process.env.MCP_DATABASE_URL    = 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres';
process.env.MCP_GYM_WRITER_URL  = 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres';
```

- [ ] **Step 3: Run server tests, expect them to still pass**

```bash
cd supabase && supabase db reset && cd ..
cd mcp-server && npm test -- index.test.ts
```

Expected: all green. (We haven't registered new tools yet — the existing tools/list assertions still hold.)

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/index.ts mcp-server/src/index.test.ts
git commit -m "feat(mcp): add second pool for gym writer"
```

---

## Task 7: Tool — `gym_search_exercises`

**Files:**
- Create: `mcp-server/src/tools/gym/catalog.ts`
- Create: `mcp-server/src/tools/gym/catalog.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-server/src/tools/gym/catalog.test.ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { searchExercises } from './catalog.js';

const readPool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await readPool.end(); await adminPool.end(); });

beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
});

describe('searchExercises', () => {
  it('returns exercises matching by display_name fragment (case-insensitive)', async () => {
    await adminPool.query(`
      INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES
        ('seated-cable-row', 'Seated Cable Row', 'lats',  'cable'),
        ('bench-press',      'Bench Press',      'chest', 'barbell')
    `);
    const r = await searchExercises(readPool, { query: 'cable' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].slug).toBe('seated-cable-row');
  });

  it('returns all when query is empty', async () => {
    await adminPool.query(`
      INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES
        ('a', 'A', 'm', 'machine'), ('b', 'B', 'm', 'machine')
    `);
    const r = await searchExercises(readPool, {});
    expect(r.rows).toHaveLength(2);
  });

  it('excludes soft-deleted rows', async () => {
    await adminPool.query(`
      INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class, deleted_at)
        VALUES ('gone', 'Gone', 'm', 'machine', now())
    `);
    const r = await searchExercises(readPool, {});
    expect(r.rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Write `mcp-server/src/tools/gym/catalog.ts` with `searchExercises`**

```ts
import type { Pool } from '../../db.js';

export interface ExerciseRow {
  id: number;
  slug: string;
  display_name: string;
  primary_muscle: string;
  secondary_muscles: string[];
  mechanic: string | null;
  equipment_class: string;
}

export interface SearchExercisesInput { query?: string; limit?: number }
export interface SearchExercisesResult { rows: ExerciseRow[] }

const DEFAULT_LIMIT = 20;

export async function searchExercises(pool: Pool, input: SearchExercisesInput): Promise<SearchExercisesResult> {
  const q = (input.query ?? '').trim();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const r = await pool.query<ExerciseRow>(
    `SELECT id, slug, display_name, primary_muscle, secondary_muscles, mechanic, equipment_class
       FROM exercises
      WHERE deleted_at IS NULL
        AND ($1 = '' OR display_name ILIKE '%' || $1 || '%' OR slug ILIKE '%' || $1 || '%')
      ORDER BY display_name
      LIMIT $2`,
    [q, limit]
  );
  return { rows: r.rows };
}
```

- [ ] **Step 3: Run test**

```bash
cd mcp-server && npm test -- catalog.test.ts
```

Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/gym/catalog.ts mcp-server/src/tools/gym/catalog.test.ts
git commit -m "feat(gym): gym_search_exercises tool"
```

---

## Task 8: Tool — `gym_create_exercise`

**Files:**
- Modify: `mcp-server/src/tools/gym/catalog.ts`
- Modify: `mcp-server/src/tools/gym/catalog.test.ts`

- [ ] **Step 1: Append the failing test**

Add to `catalog.test.ts`:

```ts
import { createExercise } from './catalog.js';
const writePool = createPool(process.env.MCP_GYM_WRITER_URL ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
// extend afterAll: await writePool.end();

describe('createExercise', () => {
  it('inserts a new exercise', async () => {
    const r = await createExercise(writePool, {
      slug: 'incline-db-press',
      display_name: 'Incline Dumbbell Press',
      primary_muscle: 'chest',
      secondary_muscles: ['front delts', 'triceps'],
      mechanic: 'compound',
      equipment_class: 'dumbbell'
    });
    expect(r.row.slug).toBe('incline-db-press');
    expect(r.row.secondary_muscles).toEqual(['front delts', 'triceps']);
    expect(r.created).toBe(true);
  });

  it('returns the existing row on slug conflict (idempotent)', async () => {
    await createExercise(writePool, {
      slug: 'lat-pulldown', display_name: 'Lat Pulldown', primary_muscle: 'lats', equipment_class: 'cable'
    });
    const r = await createExercise(writePool, {
      slug: 'lat-pulldown', display_name: 'Lat Pulldown', primary_muscle: 'lats', equipment_class: 'cable'
    });
    expect(r.created).toBe(false);
    expect(r.row.slug).toBe('lat-pulldown');
  });
});
```

You must also extend `afterAll` to close the new pool. Update the existing `afterAll(async () => { await readPool.end(); await adminPool.end(); });` to `await writePool.end();` as well.

- [ ] **Step 2: Append `createExercise` to `catalog.ts`**

```ts
export interface CreateExerciseInput {
  slug: string;
  display_name: string;
  primary_muscle: string;
  secondary_muscles?: string[];
  mechanic?: 'compound' | 'isolation' | null;
  equipment_class: string;
}
export interface CreateExerciseResult { row: ExerciseRow; created: boolean }

export async function createExercise(pool: Pool, input: CreateExerciseInput): Promise<CreateExerciseResult> {
  const r = await pool.query<ExerciseRow>(
    `INSERT INTO exercises (slug, display_name, primary_muscle, secondary_muscles, mechanic, equipment_class)
     VALUES ($1, $2, $3, COALESCE($4, '{}'), $5, $6)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, display_name, primary_muscle, secondary_muscles, mechanic, equipment_class`,
    [input.slug, input.display_name, input.primary_muscle, input.secondary_muscles ?? null, input.mechanic ?? null, input.equipment_class]
  );
  if (r.rows[0]) return { row: r.rows[0], created: true };
  const existing = await pool.query<ExerciseRow>(
    `SELECT id, slug, display_name, primary_muscle, secondary_muscles, mechanic, equipment_class
       FROM exercises WHERE slug = $1`,
    [input.slug]
  );
  return { row: existing.rows[0], created: false };
}
```

- [ ] **Step 3: Run**

```bash
cd mcp-server && npm test -- catalog.test.ts
```

Expected: 5 passing.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/gym/catalog.ts mcp-server/src/tools/gym/catalog.test.ts
git commit -m "feat(gym): gym_create_exercise tool"
```

---

## Task 9: Tools — gyms and machines catalog (`search_gyms`, `create_gym`, `search_machines`, `create_machine`)

**Files:**
- Modify: `mcp-server/src/tools/gym/catalog.ts`
- Modify: `mcp-server/src/tools/gym/catalog.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
import { searchGyms, createGym, searchMachines, createMachine } from './catalog.js';

describe('gyms', () => {
  it('createGym + searchGyms', async () => {
    const c = await createGym(writePool, { slug: 'fitfabric-wola', display_name: 'FitFabric Wola', city: 'Warsaw' });
    expect(c.created).toBe(true);
    const s = await searchGyms(readPool, { query: 'fit' });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].slug).toBe('fitfabric-wola');
  });

  it('createGym is idempotent on slug', async () => {
    await createGym(writePool, { slug: 'precor', display_name: 'Precor' });
    const r2 = await createGym(writePool, { slug: 'precor', display_name: 'Precor' });
    expect(r2.created).toBe(false);
  });
});

describe('machines', () => {
  it('createMachine + searchMachines for a (gym, exercise)', async () => {
    const gym = await createGym(writePool, { slug: 'g1', display_name: 'G1' });
    const ex  = await createExercise(writePool, { slug: 'low-row', display_name: 'Low Row', primary_muscle: 'lats', equipment_class: 'machine' });
    const m   = await createMachine(writePool, { gym_id: gym.row.id, exercise_id: ex.row.id, manufacturer: 'Technogym', model: 'Selection 700 Low Row' });
    expect(m.created).toBe(true);
    const s = await searchMachines(readPool, { gym_id: gym.row.id, exercise_id: ex.row.id });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].manufacturer).toBe('Technogym');
  });

  it('createMachine is idempotent on (gym, exercise, manufacturer, model) — including NULLs', async () => {
    const gym = await createGym(writePool, { slug: 'g2', display_name: 'G2' });
    const ex  = await createExercise(writePool, { slug: 'pec-deck', display_name: 'Pec Deck', primary_muscle: 'chest', equipment_class: 'machine' });
    await createMachine(writePool, { gym_id: gym.row.id, exercise_id: ex.row.id });
    const r2 = await createMachine(writePool, { gym_id: gym.row.id, exercise_id: ex.row.id });
    expect(r2.created).toBe(false);
  });
});
```

- [ ] **Step 2: Append implementations to `catalog.ts`**

```ts
export interface GymRow { id: number; slug: string; display_name: string; city: string | null; notes: string | null }
export interface MachineRow { id: number; gym_id: number; exercise_id: number; manufacturer: string | null; model: string | null; label: string | null; notes: string | null }

export interface SearchGymsInput { query?: string; limit?: number }
export async function searchGyms(pool: Pool, input: SearchGymsInput): Promise<{ rows: GymRow[] }> {
  const q = (input.query ?? '').trim();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const r = await pool.query<GymRow>(
    `SELECT id, slug, display_name, city, notes
       FROM gyms
      WHERE deleted_at IS NULL
        AND ($1 = '' OR display_name ILIKE '%' || $1 || '%' OR slug ILIKE '%' || $1 || '%' OR COALESCE(city,'') ILIKE '%' || $1 || '%')
      ORDER BY display_name
      LIMIT $2`,
    [q, limit]
  );
  return { rows: r.rows };
}

export interface CreateGymInput { slug: string; display_name: string; city?: string; notes?: string }
export async function createGym(pool: Pool, input: CreateGymInput): Promise<{ row: GymRow; created: boolean }> {
  const r = await pool.query<GymRow>(
    `INSERT INTO gyms (slug, display_name, city, notes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, display_name, city, notes`,
    [input.slug, input.display_name, input.city ?? null, input.notes ?? null]
  );
  if (r.rows[0]) return { row: r.rows[0], created: true };
  const existing = await pool.query<GymRow>(`SELECT id, slug, display_name, city, notes FROM gyms WHERE slug = $1`, [input.slug]);
  return { row: existing.rows[0], created: false };
}

export interface SearchMachinesInput { gym_id: number; exercise_id?: number; query?: string; limit?: number }
export async function searchMachines(pool: Pool, input: SearchMachinesInput): Promise<{ rows: MachineRow[] }> {
  const q = (input.query ?? '').trim();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const r = await pool.query<MachineRow>(
    `SELECT id, gym_id, exercise_id, manufacturer, model, label, notes
       FROM gym_machines
      WHERE deleted_at IS NULL
        AND gym_id = $1
        AND ($2::bigint IS NULL OR exercise_id = $2)
        AND ($3 = '' OR COALESCE(manufacturer,'') ILIKE '%' || $3 || '%' OR COALESCE(model,'') ILIKE '%' || $3 || '%' OR COALESCE(label,'') ILIKE '%' || $3 || '%')
      ORDER BY id
      LIMIT $4`,
    [input.gym_id, input.exercise_id ?? null, q, limit]
  );
  return { rows: r.rows };
}

export interface CreateMachineInput { gym_id: number; exercise_id: number; manufacturer?: string; model?: string; label?: string; notes?: string }
export async function createMachine(pool: Pool, input: CreateMachineInput): Promise<{ row: MachineRow; created: boolean }> {
  // The unique index uses COALESCE(... , '') — search the same way for the existing row.
  const existing = await pool.query<MachineRow>(
    `SELECT id, gym_id, exercise_id, manufacturer, model, label, notes
       FROM gym_machines
      WHERE deleted_at IS NULL
        AND gym_id = $1
        AND exercise_id = $2
        AND COALESCE(manufacturer, '') = COALESCE($3::text, '')
        AND COALESCE(model, '')        = COALESCE($4::text, '')`,
    [input.gym_id, input.exercise_id, input.manufacturer ?? null, input.model ?? null]
  );
  if (existing.rows[0]) return { row: existing.rows[0], created: false };

  const r = await pool.query<MachineRow>(
    `INSERT INTO gym_machines (gym_id, exercise_id, manufacturer, model, label, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, gym_id, exercise_id, manufacturer, model, label, notes`,
    [input.gym_id, input.exercise_id, input.manufacturer ?? null, input.model ?? null, input.label ?? null, input.notes ?? null]
  );
  return { row: r.rows[0], created: true };
}
```

- [ ] **Step 3: Run**

```bash
cd mcp-server && npm test -- catalog.test.ts
```

Expected: 9 passing.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/gym/catalog.ts mcp-server/src/tools/gym/catalog.test.ts
git commit -m "feat(gym): gym/machine catalog tools"
```

---

## Task 10: Tool — `gym_start_session` + `gym_current_session`

**Files:**
- Create: `mcp-server/src/tools/gym/session.ts`
- Create: `mcp-server/src/tools/gym/session.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../db.js';
import { startSession, currentSession, finishSession } from './session.js';
import { createGym } from './catalog.js';

const readPool  = createPool(process.env.MCP_DATABASE_URL    ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
const writePool = createPool(process.env.MCP_GYM_WRITER_URL  ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await readPool.end(); await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
});

describe('startSession + currentSession', () => {
  it('creates an open session and exposes it via currentSession', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    const session_uuid = randomUUID();
    const r = await startSession(writePool, { session_uuid, gym_id: gym.row.id, type: 'pull' });
    expect(r.session_id).toBeGreaterThan(0);

    const cur = await currentSession(readPool);
    expect(cur.row?.id).toBe(r.session_id);
    expect(cur.row?.ended_at).toBeNull();
  });

  it('rejects a second start while one is open', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'pull' });
    await expect(startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'push' }))
      .rejects.toThrow(/open session/i);
  });

  it('force=true auto-finalizes the stale open session', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    const first = await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'pull' });
    const second = await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'push', force: true });
    expect(second.session_id).not.toBe(first.session_id);

    // First should now be finalized with the auto-closed note.
    const r = await adminPool.query<{ ended_at: Date | null; notes: string | null }>(
      `SELECT ended_at, notes FROM training_sessions WHERE id = $1`, [first.session_id]
    );
    expect(r.rows[0].ended_at).not.toBeNull();
    expect(r.rows[0].notes).toMatch(/auto-closed/);
  });

  it('is idempotent on session_uuid', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    const u = randomUUID();
    const r1 = await startSession(writePool, { session_uuid: u, gym_id: gym.row.id, type: 'pull' });
    const r2 = await startSession(writePool, { session_uuid: u, gym_id: gym.row.id, type: 'pull' });
    expect(r2.session_id).toBe(r1.session_id);
  });
});
```

- [ ] **Step 2: Write `session.ts`**

```ts
import type { Pool } from '../../db.js';

export type SessionType = 'push'|'pull'|'legs'|'upper'|'lower'|'full'|'cardio'|'mobility'|'other';

export interface SessionRow {
  id: number; uuid: string; gym_id: number; type: SessionType;
  started_at: Date; ended_at: Date | null;
  rating: number | null; notes: string | null; source: 'live'|'bulk';
}

export interface StartSessionInput {
  session_uuid: string;
  gym_id: number;
  type: SessionType;
  started_at?: string;
  force?: boolean;
}
export interface StartSessionResult { session_id: number; session_uuid: string }

export async function startSession(pool: Pool, input: StartSessionInput): Promise<StartSessionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotent: same UUID returns the existing row.
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM training_sessions WHERE uuid = $1`, [input.session_uuid]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { session_id: existing.rows[0].id, session_uuid: input.session_uuid };
    }

    const open = await client.query<{ id: number }>(
      `SELECT id FROM training_sessions WHERE ended_at IS NULL AND deleted_at IS NULL`
    );
    if (open.rows[0]) {
      if (!input.force) {
        await client.query('ROLLBACK');
        throw new Error('open session exists; pass force=true to auto-finalize it');
      }
      await client.query(
        `UPDATE training_sessions
            SET ended_at = now(),
                notes = COALESCE(notes || E'\n','') || 'auto-closed'
          WHERE id = $1`,
        [open.rows[0].id]
      );
    }

    const r = await client.query<{ id: number }>(
      `INSERT INTO training_sessions (uuid, gym_id, type, started_at, source)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), 'live')
       RETURNING id`,
      [input.session_uuid, input.gym_id, input.type, input.started_at ?? null]
    );
    await client.query('COMMIT');
    return { session_id: r.rows[0].id, session_uuid: input.session_uuid };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function currentSession(pool: Pool): Promise<{ row: SessionRow | null }> {
  const r = await pool.query<SessionRow>(`SELECT * FROM current_open_session LIMIT 1`);
  return { row: r.rows[0] ?? null };
}

// finishSession is implemented in Task 11.
export async function finishSession(_pool: Pool, _input: unknown): Promise<unknown> {
  throw new Error('not implemented');
}
```

- [ ] **Step 3: Run**

```bash
cd mcp-server && npm test -- session.test.ts
```

Expected: 4 passing for startSession + currentSession; the finishSession test (Task 11) is not present yet.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/gym/session.ts mcp-server/src/tools/gym/session.test.ts
git commit -m "feat(gym): gym_start_session and gym_current_session"
```

---

## Task 11: Tool — `gym_finish_session`

**Files:**
- Modify: `mcp-server/src/tools/gym/session.ts`
- Modify: `mcp-server/src/tools/gym/session.test.ts`

- [ ] **Step 1: Append the failing test**

```ts
describe('finishSession', () => {
  it('sets ended_at, rating, notes and returns a summary', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    const ex  = await adminPool.query<{ id: number }>(
      `INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class)
       VALUES ('row', 'Row', 'lats', 'cable') RETURNING id`
    );
    const start = await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'pull' });
    // seed one set
    const te = await adminPool.query<{ id: number }>(
      `INSERT INTO training_exercises (uuid, session_id, exercise_id, position)
       VALUES ('te-1', $1, $2, 1) RETURNING id`,
      [start.session_id, ex.rows[0].id]
    );
    await adminPool.query(
      `INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg)
       VALUES ('st-1', $1, 1, 10, 50)`,
      [te.rows[0].id]
    );

    const r = await finishSession(writePool, { session_id: start.session_id, rating: 7, notes: 'felt good' });
    expect(r.summary.total_sets).toBe(1);
    expect(r.summary.total_volume_kg).toBe(500);
    expect(r.summary.rating).toBe(7);
    expect(r.summary.ended_at).not.toBeNull();
  });

  it('refuses to finish an already-finished session', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    const start = await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'pull' });
    await finishSession(writePool, { session_id: start.session_id });
    await expect(finishSession(writePool, { session_id: start.session_id })).rejects.toThrow(/already finished/i);
  });
});
```

- [ ] **Step 2: Replace the stub `finishSession` in `session.ts`**

```ts
export interface FinishSessionInput {
  session_id: number;
  rating?: number;
  notes?: string;
  ended_at?: string;
}
export interface FinishSessionResult {
  summary: {
    session_id: number;
    started_at: Date;
    ended_at: Date;
    rating: number | null;
    total_sets: number;
    total_volume_kg: number;
  }
}

export async function finishSession(pool: Pool, input: FinishSessionInput): Promise<FinishSessionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const status = await client.query<{ ended_at: Date | null }>(
      `SELECT ended_at FROM training_sessions WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [input.session_id]
    );
    if (!status.rows[0]) {
      await client.query('ROLLBACK');
      throw new Error(`session ${input.session_id} not found`);
    }
    if (status.rows[0].ended_at) {
      await client.query('ROLLBACK');
      throw new Error(`session ${input.session_id} already finished`);
    }

    const upd = await client.query<{ id: number; started_at: Date; ended_at: Date; rating: number | null }>(
      `UPDATE training_sessions
          SET ended_at = COALESCE($2::timestamptz, now()),
              rating   = COALESCE($3, rating),
              notes    = CASE WHEN $4::text IS NULL THEN notes
                              WHEN notes IS NULL THEN $4
                              ELSE notes || E'\n' || $4 END
        WHERE id = $1
        RETURNING id, started_at, ended_at, rating`,
      [input.session_id, input.ended_at ?? null, input.rating ?? null, input.notes ?? null]
    );

    const totals = await client.query<{ total_sets: string; total_volume_kg: string }>(
      `SELECT COUNT(ts.id)                                              AS total_sets,
              COALESCE(SUM(ts.weight_kg * ts.reps), 0)::float8           AS total_volume_kg
         FROM training_exercises te
         LEFT JOIN training_sets ts ON ts.training_exercise_id = te.id AND ts.deleted_at IS NULL
        WHERE te.session_id = $1 AND te.deleted_at IS NULL`,
      [input.session_id]
    );

    await client.query('COMMIT');

    return {
      summary: {
        session_id:      upd.rows[0].id,
        started_at:      upd.rows[0].started_at,
        ended_at:        upd.rows[0].ended_at,
        rating:          upd.rows[0].rating,
        total_sets:      Number(totals.rows[0].total_sets),
        total_volume_kg: Number(totals.rows[0].total_volume_kg)
      }
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 3: Run**

```bash
cd mcp-server && npm test -- session.test.ts
```

Expected: 6 passing.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/gym/session.ts mcp-server/src/tools/gym/session.test.ts
git commit -m "feat(gym): gym_finish_session"
```

---

## Task 12: Tool — `gym_log_set` + `gym_add_note`

**Files:**
- Create: `mcp-server/src/tools/gym/sets.ts`
- Create: `mcp-server/src/tools/gym/sets.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../db.js';
import { logSet, addNote } from './sets.js';
import { createGym, createExercise } from './catalog.js';
import { startSession } from './session.js';

const writePool = createPool(process.env.MCP_GYM_WRITER_URL  ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');
afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
});

async function freshSession() {
  const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
  const ex  = await createExercise(writePool, { slug: 'row', display_name: 'Row', primary_muscle: 'lats', equipment_class: 'cable' });
  const s   = await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'pull' });
  return { gym, ex, session_id: s.session_id };
}

describe('logSet', () => {
  it('creates a new training_exercises block on the first set and returns its id', async () => {
    const { ex, session_id } = await freshSession();
    const r = await logSet(writePool, {
      session_id, exercise_id: ex.row.id, set_uuid: randomUUID(), reps: 10, weight_kg: 50
    });
    expect(r.training_exercise_id).toBeGreaterThan(0);
    expect(r.set_index).toBe(1);
  });

  it('reuses the training_exercises block when training_exercise_id is passed', async () => {
    const { ex, session_id } = await freshSession();
    const first = await logSet(writePool, {
      session_id, exercise_id: ex.row.id, set_uuid: randomUUID(), reps: 10, weight_kg: 50
    });
    const second = await logSet(writePool, {
      session_id, training_exercise_id: first.training_exercise_id, set_uuid: randomUUID(), reps: 8, weight_kg: 55
    });
    expect(second.training_exercise_id).toBe(first.training_exercise_id);
    expect(second.set_index).toBe(2);
  });

  it('is idempotent on set_uuid (no duplicate row, returns the existing set)', async () => {
    const { ex, session_id } = await freshSession();
    const u = randomUUID();
    const a = await logSet(writePool, { session_id, exercise_id: ex.row.id, set_uuid: u, reps: 10, weight_kg: 50 });
    const b = await logSet(writePool, { session_id, exercise_id: ex.row.id, set_uuid: u, reps: 999, weight_kg: 999 });
    expect(b.set_id).toBe(a.set_id);
    const stored = await adminPool.query(`SELECT reps, weight_kg FROM training_sets WHERE id = $1`, [a.set_id]);
    expect(stored.rows[0]).toEqual({ reps: 10, weight_kg: 50 });
  });

  it('rejects a set with no measurement', async () => {
    const { ex, session_id } = await freshSession();
    await expect(logSet(writePool, {
      session_id, exercise_id: ex.row.id, set_uuid: randomUUID()
    })).rejects.toThrow(/measurement/i);
  });
});

describe('addNote', () => {
  it('appends to session notes', async () => {
    const { session_id } = await freshSession();
    await addNote(writePool, { session_id, scope: 'session', text: 'first note' });
    await addNote(writePool, { session_id, scope: 'session', text: 'second note' });
    const r = await adminPool.query<{ notes: string }>(`SELECT notes FROM training_sessions WHERE id = $1`, [session_id]);
    expect(r.rows[0].notes).toBe('first note\nsecond note');
  });

  it('appends to a set when scope=set and target_id given', async () => {
    const { ex, session_id } = await freshSession();
    const s = await logSet(writePool, { session_id, exercise_id: ex.row.id, set_uuid: randomUUID(), reps: 10, weight_kg: 50 });
    await addNote(writePool, { session_id, scope: 'set', target_id: s.set_id, text: 'shoulder twinge' });
    const r = await adminPool.query<{ notes: string }>(`SELECT notes FROM training_sets WHERE id = $1`, [s.set_id]);
    expect(r.rows[0].notes).toBe('shoulder twinge');
  });
});
```

- [ ] **Step 2: Write `sets.ts`**

```ts
import type { Pool } from '../../db.js';

export interface LogSetInput {
  session_id: number;
  training_exercise_id?: number;
  exercise_id?: number;
  gym_machine_id?: number;
  set_uuid: string;
  reps?: number;
  weight_kg?: number;
  duration_seconds?: number;
  distance_m?: number;
  rpe?: number;
  is_warmup?: boolean;
  notes?: string;
  performed_at?: string;
  set_index?: number;
}

export interface LogSetResult {
  training_exercise_id: number;
  set_id: number;
  set_index: number;
}

export async function logSet(pool: Pool, input: LogSetInput): Promise<LogSetResult> {
  if (input.reps == null && input.duration_seconds == null && input.distance_m == null) {
    throw new Error('at least one measurement (reps, duration_seconds, distance_m) is required');
  }
  if (!input.training_exercise_id && !input.exercise_id) {
    throw new Error('either training_exercise_id or exercise_id is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotent: same set_uuid → return existing row, do nothing else.
    const existing = await client.query<{ id: number; training_exercise_id: number; set_index: number }>(
      `SELECT id, training_exercise_id, set_index FROM training_sets WHERE uuid = $1`,
      [input.set_uuid]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return {
        set_id: existing.rows[0].id,
        training_exercise_id: existing.rows[0].training_exercise_id,
        set_index: existing.rows[0].set_index
      };
    }

    let teId = input.training_exercise_id ?? 0;
    if (!teId) {
      const posRow = await client.query<{ next_pos: number }>(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
           FROM training_exercises WHERE session_id = $1 AND deleted_at IS NULL`,
        [input.session_id]
      );
      const teIns = await client.query<{ id: number }>(
        `INSERT INTO training_exercises (uuid, session_id, exercise_id, gym_machine_id, position)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
         RETURNING id`,
        [input.session_id, input.exercise_id, input.gym_machine_id ?? null, posRow.rows[0].next_pos]
      );
      teId = teIns.rows[0].id;
    }

    let setIndex = input.set_index ?? 0;
    if (!setIndex) {
      const idxRow = await client.query<{ next_idx: number }>(
        `SELECT COALESCE(MAX(set_index), 0) + 1 AS next_idx
           FROM training_sets WHERE training_exercise_id = $1 AND deleted_at IS NULL`,
        [teId]
      );
      setIndex = idxRow.rows[0].next_idx;
    }

    const setIns = await client.query<{ id: number }>(
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

    await client.query('COMMIT');
    return { set_id: setIns.rows[0].id, training_exercise_id: teId, set_index: setIndex };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface AddNoteInput {
  session_id: number;
  scope: 'set' | 'exercise' | 'session';
  target_id?: number;
  text: string;
}

export async function addNote(pool: Pool, input: AddNoteInput): Promise<void> {
  if (input.scope !== 'session' && !input.target_id) {
    throw new Error(`target_id is required for scope='${input.scope}'`);
  }

  if (input.scope === 'session') {
    await pool.query(
      `UPDATE training_sessions
          SET notes = CASE WHEN notes IS NULL THEN $2 ELSE notes || E'\n' || $2 END
        WHERE id = $1`,
      [input.session_id, input.text]
    );
    return;
  }

  if (input.scope === 'exercise') {
    await pool.query(
      `UPDATE training_exercises
          SET notes = CASE WHEN notes IS NULL THEN $2 ELSE notes || E'\n' || $2 END
        WHERE id = $1 AND session_id = $3`,
      [input.target_id, input.text, input.session_id]
    );
    return;
  }

  // scope === 'set'
  await pool.query(
    `UPDATE training_sets
        SET notes = CASE WHEN notes IS NULL THEN $2 ELSE notes || E'\n' || $2 END
      WHERE id = $1
        AND training_exercise_id IN (SELECT id FROM training_exercises WHERE session_id = $3)`,
    [input.target_id, input.text, input.session_id]
  );
}
```

- [ ] **Step 3: Run**

```bash
cd mcp-server && npm test -- sets.test.ts
```

Expected: 6 passing.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/gym/sets.ts mcp-server/src/tools/gym/sets.test.ts
git commit -m "feat(gym): gym_log_set and gym_add_note"
```

---

## Task 13: Tools — `gym_last_session_summary` + `gym_last_exercise_results`

**Files:**
- Create: `mcp-server/src/tools/gym/lookup.ts`
- Create: `mcp-server/src/tools/gym/lookup.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { lastSessionSummary, lastExerciseResults } from './lookup.js';

const readPool  = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');
afterAll(async () => { await readPool.end(); await adminPool.end(); });

beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
  await adminPool.query(`
    INSERT INTO gyms (slug, display_name) VALUES ('wola', 'Wola'), ('mok', 'Mokotów');
    INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES ('row', 'Row', 'lats', 'cable');
  `);
  await adminPool.query(`
    -- older session at Wola
    INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating)
      VALUES ('s-wola', (SELECT id FROM gyms WHERE slug='wola'), 'pull',
              '2026-04-15T17:00:00Z', '2026-04-15T18:00:00Z', 6);
    INSERT INTO training_exercises (uuid, session_id, exercise_id, position)
      VALUES ('te-wola', (SELECT id FROM training_sessions WHERE uuid='s-wola'),
              (SELECT id FROM exercises WHERE slug='row'), 1);
    INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg)
      VALUES ('st-wola-1', (SELECT id FROM training_exercises WHERE uuid='te-wola'), 1, 10, 50),
             ('st-wola-2', (SELECT id FROM training_exercises WHERE uuid='te-wola'), 2, 10, 55);

    -- newer session at Mokotów
    INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating)
      VALUES ('s-mok', (SELECT id FROM gyms WHERE slug='mok'), 'pull',
              '2026-05-08T17:00:00Z', '2026-05-08T18:00:00Z', 8);
    INSERT INTO training_exercises (uuid, session_id, exercise_id, position)
      VALUES ('te-mok', (SELECT id FROM training_sessions WHERE uuid='s-mok'),
              (SELECT id FROM exercises WHERE slug='row'), 1);
    INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg)
      VALUES ('st-mok-1', (SELECT id FROM training_exercises WHERE uuid='te-mok'), 1, 10, 60);
  `);
});

describe('lookup', () => {
  it('lastSessionSummary returns same-gym row first, then other-gym row', async () => {
    const wolaId = (await adminPool.query<{ id: number }>(`SELECT id FROM gyms WHERE slug='wola'`)).rows[0].id;
    const r = await lastSessionSummary(readPool, { type: 'pull', gym_id: wolaId });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].same_gym).toBe(true);
    expect(r.rows[0].total_sets).toBe(2);
    expect(r.rows[1].same_gym).toBe(false);
  });

  it('lastExerciseResults returns sets[] for each row', async () => {
    const wolaId = (await adminPool.query<{ id: number }>(`SELECT id FROM gyms WHERE slug='wola'`)).rows[0].id;
    const exId   = (await adminPool.query<{ id: number }>(`SELECT id FROM exercises WHERE slug='row'`)).rows[0].id;
    const r = await lastExerciseResults(readPool, { exercise_id: exId, current_gym_id: wolaId });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].same_gym).toBe(true);
    expect(Array.isArray(r.rows[0].sets)).toBe(true);
    expect(r.rows[0].sets).toHaveLength(2);
  });

  it('accepts exercise_slug as an alternative to exercise_id', async () => {
    const wolaId = (await adminPool.query<{ id: number }>(`SELECT id FROM gyms WHERE slug='wola'`)).rows[0].id;
    const r = await lastExerciseResults(readPool, { exercise_slug: 'row', current_gym_id: wolaId });
    expect(r.rows).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Write `lookup.ts`**

```ts
import type { Pool } from '../../db.js';

export interface LastSessionRow {
  session_id: number;
  gym_id: number;
  gym_slug: string;
  same_gym: boolean;
  started_at: Date;
  ended_at: Date;
  rating: number | null;
  total_sets: number;
  total_volume_kg: number;
  top_set: { exercise: string; reps: number; weight_kg: number } | null;
}

export async function lastSessionSummary(pool: Pool, input: { type: string; gym_id: number }): Promise<{ rows: LastSessionRow[] }> {
  const r = await pool.query<LastSessionRow & { total_sets: string; total_volume_kg: string }>(
    `SELECT session_id, gym_id, gym_slug, same_gym, started_at, ended_at, rating,
            total_sets, total_volume_kg, top_set
       FROM last_sessions_by_type($1, $2)`,
    [input.type, input.gym_id]
  );
  return {
    rows: r.rows.map((row) => ({
      ...row,
      total_sets: Number(row.total_sets),
      total_volume_kg: Number(row.total_volume_kg)
    }))
  };
}

export interface LastExerciseRow {
  training_exercise_id: number;
  session_id: number;
  gym_id: number;
  gym_slug: string;
  same_gym: boolean;
  performed_at: Date;
  sets: Array<{ set_index: number; reps: number | null; weight_kg: number | null; rpe: number | null; is_warmup: boolean; notes: string | null }>;
}

export async function lastExerciseResults(
  pool: Pool,
  input: { exercise_id?: number; exercise_slug?: string; current_gym_id: number }
): Promise<{ rows: LastExerciseRow[] }> {
  let exerciseId = input.exercise_id;
  if (!exerciseId) {
    if (!input.exercise_slug) throw new Error('exercise_id or exercise_slug required');
    const r = await pool.query<{ id: number }>(`SELECT id FROM exercises WHERE slug = $1 AND deleted_at IS NULL`, [input.exercise_slug]);
    if (!r.rows[0]) throw new Error(`unknown exercise slug: ${input.exercise_slug}`);
    exerciseId = r.rows[0].id;
  }
  const r = await pool.query<LastExerciseRow>(
    `SELECT training_exercise_id, session_id, gym_id, gym_slug, same_gym, performed_at, sets
       FROM last_exercise_results($1, $2)`,
    [exerciseId, input.current_gym_id]
  );
  return { rows: r.rows };
}
```

- [ ] **Step 3: Run**

```bash
cd mcp-server && npm test -- lookup.test.ts
```

Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/gym/lookup.ts mcp-server/src/tools/gym/lookup.test.ts
git commit -m "feat(gym): comparison helpers (last_session_summary, last_exercise_results)"
```

---

## Task 14: Tool — `gym_submit_session_bulk`

**Files:**
- Create: `mcp-server/src/tools/gym/bulk.ts`
- Create: `mcp-server/src/tools/gym/bulk.test.ts`
- Create: `mcp-server/test/fixtures/bulk-session.json`

- [ ] **Step 1: Add the golden fixture**

`mcp-server/test/fixtures/bulk-session.json`:

```json
{
  "session_uuid": "11111111-1111-1111-1111-111111111111",
  "gym_slug": "fitfabric-wola",
  "type": "pull",
  "started_at": "2026-05-08T17:30:00Z",
  "ended_at":   "2026-05-08T18:45:00Z",
  "rating": 7,
  "notes": "Felt heavy",
  "exercises": [
    {
      "exercise_slug": "seated-cable-row",
      "exercise_uuid": "22222222-2222-2222-2222-222222222222",
      "sets": [
        { "set_uuid": "33333333-3333-3333-3333-333333333331", "reps": 12, "weight_kg": 50 },
        { "set_uuid": "33333333-3333-3333-3333-333333333332", "reps": 10, "weight_kg": 55 },
        { "set_uuid": "33333333-3333-3333-3333-333333333333", "reps":  8, "weight_kg": 60 }
      ]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '../../db.js';
import { submitSessionBulk } from './bulk.js';

const writePool = createPool(process.env.MCP_GYM_WRITER_URL  ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
});

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/bulk-session.json'), 'utf8'));

describe('submitSessionBulk', () => {
  it('rejects unknown gym slug', async () => {
    await expect(submitSessionBulk(writePool, fixture)).rejects.toThrow(/unknown gym slug.*fitfabric-wola/i);
  });

  it('rejects unknown exercise slug when gym exists', async () => {
    await adminPool.query(`INSERT INTO gyms (slug, display_name) VALUES ('fitfabric-wola', 'FitFabric Wola')`);
    await expect(submitSessionBulk(writePool, fixture)).rejects.toThrow(/unknown exercise slug.*seated-cable-row/i);
  });

  it('imports a complete session atomically and is idempotent on session_uuid', async () => {
    await adminPool.query(`INSERT INTO gyms (slug, display_name) VALUES ('fitfabric-wola', 'FitFabric Wola')`);
    await adminPool.query(`INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES ('seated-cable-row', 'Seated Cable Row', 'lats', 'cable')`);

    const first = await submitSessionBulk(writePool, fixture);
    expect(first.summary.total_sets).toBe(3);
    expect(first.summary.total_volume_kg).toBe(12*50 + 10*55 + 8*60);

    const second = await submitSessionBulk(writePool, fixture);
    expect(second.session_id).toBe(first.session_id); // idempotent
  });

  it('a malformed payload (missing required field) is rejected by Zod', async () => {
    const broken = { ...fixture, gym_slug: undefined };
    await expect(submitSessionBulk(writePool, broken)).rejects.toThrow(/gym_slug/i);
  });
});
```

- [ ] **Step 3: Write `bulk.ts`**

```ts
import { z } from 'zod';
import type { Pool } from '../../db.js';

const SetSchema = z.object({
  set_uuid:         z.string().min(1),
  set_index:        z.number().int().positive().optional(),
  reps:             z.number().int().optional(),
  weight_kg:        z.number().optional(),
  duration_seconds: z.number().optional(),
  distance_m:       z.number().optional(),
  rpe:              z.number().int().min(1).max(10).optional(),
  is_warmup:        z.boolean().optional(),
  notes:            z.string().nullable().optional(),
  performed_at:     z.string().optional()
}).refine(
  (v) => v.reps != null || v.duration_seconds != null || v.distance_m != null,
  { message: 'each set requires at least one of reps/duration_seconds/distance_m' }
);

const ExerciseSchema = z.object({
  exercise_slug:  z.string().min(1),
  exercise_uuid:  z.string().min(1),
  machine:        z.object({ manufacturer: z.string().nullable().optional(), model: z.string().nullable().optional(), label: z.string().nullable().optional() }).optional(),
  notes:          z.string().nullable().optional(),
  sets:           z.array(SetSchema).min(1)
});

export const BulkPayloadSchema = z.object({
  session_uuid: z.string().min(1),
  gym_slug:     z.string().min(1),
  type:         z.enum(['push','pull','legs','upper','lower','full','cardio','mobility','other']),
  started_at:   z.string(),
  ended_at:     z.string(),
  rating:       z.number().int().min(1).max(10).nullable().optional(),
  notes:        z.string().nullable().optional(),
  exercises:    z.array(ExerciseSchema).min(1)
});

export type BulkPayload = z.infer<typeof BulkPayloadSchema>;

export interface BulkResult {
  session_id: number;
  summary: { total_sets: number; total_volume_kg: number };
}

export async function submitSessionBulk(pool: Pool, raw: unknown): Promise<BulkResult> {
  const payload = BulkPayloadSchema.parse(raw);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotent on session_uuid
    const existing = await client.query<{ id: number }>(
      `SELECT id FROM training_sessions WHERE uuid = $1`, [payload.session_uuid]
    );
    if (existing.rows[0]) {
      const totals = await client.query<{ total_sets: string; total_volume_kg: string }>(
        `SELECT COUNT(ts.id) AS total_sets,
                COALESCE(SUM(ts.weight_kg * ts.reps), 0)::float8 AS total_volume_kg
           FROM training_exercises te
           LEFT JOIN training_sets ts ON ts.training_exercise_id = te.id AND ts.deleted_at IS NULL
          WHERE te.session_id = $1 AND te.deleted_at IS NULL`,
        [existing.rows[0].id]
      );
      await client.query('COMMIT');
      return {
        session_id: existing.rows[0].id,
        summary: { total_sets: Number(totals.rows[0].total_sets), total_volume_kg: Number(totals.rows[0].total_volume_kg) }
      };
    }

    // Resolve gym
    const gym = await client.query<{ id: number }>(`SELECT id FROM gyms WHERE slug = $1 AND deleted_at IS NULL`, [payload.gym_slug]);
    if (!gym.rows[0]) {
      await client.query('ROLLBACK');
      throw new Error(`unknown gym slug: ${payload.gym_slug}`);
    }
    const gymId = gym.rows[0].id;

    // Resolve all exercise slugs in a single query so we can list every unknown
    const slugs = payload.exercises.map((e) => e.exercise_slug);
    const exRows = await client.query<{ slug: string; id: number }>(
      `SELECT slug, id FROM exercises WHERE slug = ANY($1) AND deleted_at IS NULL`,
      [slugs]
    );
    const exBySlug = new Map(exRows.rows.map((r) => [r.slug, r.id]));
    const unknown = slugs.filter((s) => !exBySlug.has(s));
    if (unknown.length > 0) {
      await client.query('ROLLBACK');
      throw new Error(`unknown exercise slug(s): ${unknown.join(', ')}`);
    }

    // Insert session row
    const sIns = await client.query<{ id: number }>(
      `INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating, notes, source)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'bulk')
       RETURNING id`,
      [payload.session_uuid, gymId, payload.type, payload.started_at, payload.ended_at, payload.rating ?? null, payload.notes ?? null]
    );
    const sessionId = sIns.rows[0].id;

    let totalSets = 0;
    let totalVolume = 0;
    for (let i = 0; i < payload.exercises.length; i++) {
      const ex = payload.exercises[i];
      const exerciseId = exBySlug.get(ex.exercise_slug)!;

      let machineId: number | null = null;
      if (ex.machine) {
        const m = await client.query<{ id: number }>(
          `SELECT id FROM gym_machines
            WHERE deleted_at IS NULL AND gym_id = $1 AND exercise_id = $2
              AND COALESCE(manufacturer, '') = COALESCE($3::text, '')
              AND COALESCE(model, '')        = COALESCE($4::text, '')`,
          [gymId, exerciseId, ex.machine.manufacturer ?? null, ex.machine.model ?? null]
        );
        if (!m.rows[0]) {
          await client.query('ROLLBACK');
          throw new Error(
            `unknown gym_machine for gym=${payload.gym_slug} exercise=${ex.exercise_slug} ` +
            `manufacturer=${ex.machine.manufacturer ?? 'NULL'} model=${ex.machine.model ?? 'NULL'}`
          );
        }
        machineId = m.rows[0].id;
      }

      const teIns = await client.query<{ id: number }>(
        `INSERT INTO training_exercises (uuid, session_id, exercise_id, gym_machine_id, position, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [ex.exercise_uuid, sessionId, exerciseId, machineId, i + 1, ex.notes ?? null]
      );
      const teId = teIns.rows[0].id;

      for (let j = 0; j < ex.sets.length; j++) {
        const st = ex.sets[j];
        await client.query(
          `INSERT INTO training_sets
             (uuid, training_exercise_id, set_index, reps, weight_kg, duration_seconds, distance_m, rpe, is_warmup, notes, performed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, false), $10, COALESCE($11::timestamptz, $12))`,
          [
            st.set_uuid, teId, st.set_index ?? (j + 1),
            st.reps ?? null, st.weight_kg ?? null,
            st.duration_seconds ?? null, st.distance_m ?? null,
            st.rpe ?? null, st.is_warmup ?? null,
            st.notes ?? null, st.performed_at ?? null, payload.started_at
          ]
        );
        totalSets += 1;
        if (st.reps != null && st.weight_kg != null) totalVolume += st.reps * st.weight_kg;
      }
    }

    await client.query('COMMIT');
    return {
      session_id: sessionId,
      summary: { total_sets: totalSets, total_volume_kg: totalVolume }
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 3: Run**

```bash
cd mcp-server && npm test -- bulk.test.ts
```

Expected: 4 passing.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/tools/gym/bulk.ts mcp-server/src/tools/gym/bulk.test.ts mcp-server/test/fixtures/bulk-session.json
git commit -m "feat(gym): gym_submit_session_bulk with strict slug resolution"
```

---

## Task 15: Resource — extend `schema://tables` with the Gym section

**Files:**
- Modify: `mcp-server/src/resources/schema.ts`
- Modify: `mcp-server/src/resources/schema.test.ts`

- [ ] **Step 1: Update `schema.test.ts` to assert new content**

Find the existing assertions and add:

```ts
it('lists the gym tables', async () => {
  const md = await describeSchema(pool);
  expect(md).toMatch(/training_sessions/);
  expect(md).toMatch(/training_sets/);
  expect(md).toMatch(/exercises/);
});

it('documents the gym helpers', async () => {
  const md = await describeSchema(pool);
  expect(md).toMatch(/last_sessions_by_type/);
  expect(md).toMatch(/last_exercise_results/);
});
```

(Place these within the existing `describe('describeSchema', ...)` block — keep the existing health assertions.)

- [ ] **Step 2: Extend `schema.ts`**

Add the new tables to the table list and append a Gym section:

```ts
// in the SELECT for `cols`:
//   AND table_name IN ('health_samples','device_state','summary_cache',
//                      'exercises','gyms','gym_machines',
//                      'training_sessions','training_exercises','training_sets')
```

And append after the existing helper bullet list:

```ts
'## Gym helpers',
'',
'- `last_sessions_by_type(p_type TEXT, p_gym_id BIGINT)` — up to 2 rows: most-recent same-gym session of the given type, then most-recent other-gym session. Columns: session_id, gym_id, gym_slug, same_gym, started_at, ended_at, rating, total_sets, total_volume_kg, top_set (jsonb).',
'- `last_exercise_results(p_exercise_id BIGINT, p_current_gym_id BIGINT)` — same shape for a specific exercise. `sets` is a JSONB array of `{set_index, reps, weight_kg, rpe, is_warmup, notes}`.',
'- View `current_open_session` — exactly the open session row (or empty).',
'',
'## Gym example queries',
'',
'```sql',
'-- most recent push session at a gym',
"SELECT * FROM last_sessions_by_type('push', (SELECT id FROM gyms WHERE slug='fitfabric-wola'));",
'',
'-- weekly volume across all sessions',
'SELECT date_trunc(\'week\', s.started_at)::date AS week,',
'       COALESCE(SUM(ts.weight_kg * ts.reps), 0) AS volume_kg',
'  FROM training_sessions s',
'  JOIN training_exercises te ON te.session_id = s.id AND te.deleted_at IS NULL',
'  JOIN training_sets ts      ON ts.training_exercise_id = te.id AND ts.deleted_at IS NULL',
' WHERE s.deleted_at IS NULL AND s.ended_at IS NOT NULL',
' GROUP BY 1 ORDER BY 1 DESC;',
'',
'-- cross-domain: average session rating vs HRV the prior night',
"SELECT s.rating,",
"       AVG(hs.value) FILTER (WHERE hs.data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN')",
'  FROM training_sessions s',
"  LEFT JOIN health_samples hs ON hs.deleted_at IS NULL",
"   AND hs.start_date >= s.started_at - INTERVAL '24 hours'",
"   AND hs.start_date <  s.started_at",
' WHERE s.deleted_at IS NULL AND s.rating IS NOT NULL',
' GROUP BY s.rating ORDER BY s.rating;',
'```'
```

Splice these into the existing return-value array assembly in `describeSchema`.

- [ ] **Step 3: Run**

```bash
cd mcp-server && npm test -- schema.test.ts
```

Expected: all existing health-schema tests still pass, plus the two new ones.

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/resources/schema.ts mcp-server/src/resources/schema.test.ts
git commit -m "feat(gym): extend schema://tables resource with gym section"
```

---

## Task 16: Register all 13 gym tools in `index.ts`

**Files:**
- Modify: `mcp-server/src/index.ts`
- Modify: `mcp-server/src/index.test.ts`

- [ ] **Step 1: Update `index.test.ts` end-to-end assertion**

Append to the existing tools/list test:

```ts
expect(text).toMatch(/gym_start_session/);
expect(text).toMatch(/gym_log_set/);
expect(text).toMatch(/gym_finish_session/);
expect(text).toMatch(/gym_submit_session_bulk/);
expect(text).toMatch(/gym_search_exercises/);
expect(text).toMatch(/gym_create_exercise/);
expect(text).toMatch(/gym_last_session_summary/);
expect(text).toMatch(/gym_last_exercise_results/);
expect(text).toMatch(/gym_current_session/);
```

- [ ] **Step 2: Edit `index.ts` to register all gym tools inside `buildMcp(readPool, writePool)`**

Add imports near the top:

```ts
import { searchExercises, createExercise, searchGyms, createGym, searchMachines, createMachine } from './tools/gym/catalog.js';
import { startSession, currentSession, finishSession } from './tools/gym/session.js';
import { logSet, addNote } from './tools/gym/sets.js';
import { lastSessionSummary, lastExerciseResults } from './tools/gym/lookup.js';
import { submitSessionBulk } from './tools/gym/bulk.js';
```

Inside `buildMcp(readPool, writePool)`, after the existing `run_sql` registration, append:

```ts
const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

// --- Catalog (search uses readPool, create uses writePool) -------------
server.registerTool('gym_search_exercises',
  { description: 'Search exercises by name/slug substring. Use before gym_create_exercise to avoid duplicates.',
    inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().positive().optional() }) },
  async (i) => text(await searchExercises(readPool, i))
);
server.registerTool('gym_create_exercise',
  { description: 'Create a new exercise. Search first; only call after the user confirms.',
    inputSchema: z.object({
      slug: z.string().min(1),
      display_name: z.string().min(1),
      primary_muscle: z.string().min(1),
      secondary_muscles: z.array(z.string()).optional(),
      mechanic: z.enum(['compound','isolation']).nullable().optional(),
      equipment_class: z.string().min(1)
    }) },
  async (i) => text(await createExercise(writePool, i))
);
server.registerTool('gym_search_gyms',
  { description: 'Search gyms by name/slug/city substring.',
    inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().positive().optional() }) },
  async (i) => text(await searchGyms(readPool, i))
);
server.registerTool('gym_create_gym',
  { description: 'Create a new gym after user confirmation.',
    inputSchema: z.object({ slug: z.string().min(1), display_name: z.string().min(1), city: z.string().optional(), notes: z.string().optional() }) },
  async (i) => text(await createGym(writePool, i))
);
server.registerTool('gym_search_machines',
  { description: 'List machines at a gym (optionally filtered by exercise).',
    inputSchema: z.object({ gym_id: z.number().int().positive(), exercise_id: z.number().int().positive().optional(), query: z.string().optional(), limit: z.number().int().positive().optional() }) },
  async (i) => text(await searchMachines(readPool, i))
);
server.registerTool('gym_create_machine',
  { description: 'Create a machine at a gym for an exercise.',
    inputSchema: z.object({ gym_id: z.number().int().positive(), exercise_id: z.number().int().positive(), manufacturer: z.string().optional(), model: z.string().optional(), label: z.string().optional(), notes: z.string().optional() }) },
  async (i) => text(await createMachine(writePool, i))
);

// --- Session ---------------------------------------------------------
server.registerTool('gym_start_session',
  { description: 'Start a new live session. Fails if another is open; pass force=true to auto-finalize the stale one.',
    inputSchema: z.object({
      session_uuid: z.string().min(1),
      gym_id: z.number().int().positive(),
      type: z.enum(['push','pull','legs','upper','lower','full','cardio','mobility','other']),
      started_at: z.string().optional(),
      force: z.boolean().optional()
    }) },
  async (i) => text(await startSession(writePool, i))
);
server.registerTool('gym_current_session',
  { description: 'Return the open session (or null).', inputSchema: z.object({}) },
  async () => text(await currentSession(readPool))
);
server.registerTool('gym_finish_session',
  { description: 'Finalize a session with optional rating (1..10) and notes. Returns a summary.',
    inputSchema: z.object({
      session_id: z.number().int().positive(),
      rating: z.number().int().min(1).max(10).optional(),
      notes: z.string().optional(),
      ended_at: z.string().optional()
    }) },
  async (i) => text(await finishSession(writePool, i))
);

// --- Sets -----------------------------------------------------------
server.registerTool('gym_log_set',
  { description: 'Log a single set. Pass training_exercise_id to reuse a block, or exercise_id (+gym_machine_id?) to start a new one. Caller must reuse the returned training_exercise_id for subsequent sets of the same exercise.',
    inputSchema: z.object({
      session_id: z.number().int().positive(),
      training_exercise_id: z.number().int().positive().optional(),
      exercise_id: z.number().int().positive().optional(),
      gym_machine_id: z.number().int().positive().optional(),
      set_uuid: z.string().min(1),
      reps: z.number().int().optional(),
      weight_kg: z.number().optional(),
      duration_seconds: z.number().optional(),
      distance_m: z.number().optional(),
      rpe: z.number().int().min(1).max(10).optional(),
      is_warmup: z.boolean().optional(),
      notes: z.string().optional(),
      performed_at: z.string().optional(),
      set_index: z.number().int().positive().optional()
    }) },
  async (i) => text(await logSet(writePool, i))
);
server.registerTool('gym_add_note',
  { description: 'Append a free-text note to a session, exercise, or set. Newline-appended; never destructive.',
    inputSchema: z.object({
      session_id: z.number().int().positive(),
      scope: z.enum(['set','exercise','session']),
      target_id: z.number().int().positive().optional(),
      text: z.string().min(1)
    }) },
  async (i) => { await addNote(writePool, i); return text({ ok: true }); }
);

// --- Lookup ----------------------------------------------------------
server.registerTool('gym_last_session_summary',
  { description: 'Up to 2 rows: most-recent same-gym session of this type, then most-recent other-gym session.',
    inputSchema: z.object({
      type: z.enum(['push','pull','legs','upper','lower','full','cardio','mobility','other']),
      gym_id: z.number().int().positive()
    }) },
  async (i) => text(await lastSessionSummary(readPool, i))
);
server.registerTool('gym_last_exercise_results',
  { description: 'Up to 2 rows of prior performances of this exercise: same-gym then other-gym.',
    inputSchema: z.object({
      exercise_id: z.number().int().positive().optional(),
      exercise_slug: z.string().optional(),
      current_gym_id: z.number().int().positive()
    }) },
  async (i) => text(await lastExerciseResults(readPool, i))
);

// --- Bulk ------------------------------------------------------------
server.registerTool('gym_submit_session_bulk',
  { description: 'Atomic import of a complete finished session. Rejects unknown slugs. Idempotent on session_uuid.',
    inputSchema: z.object({
      session_uuid: z.string().min(1),
      gym_slug:     z.string().min(1),
      type:         z.enum(['push','pull','legs','upper','lower','full','cardio','mobility','other']),
      started_at:   z.string(),
      ended_at:     z.string(),
      rating:       z.number().int().min(1).max(10).nullable().optional(),
      notes:        z.string().nullable().optional(),
      exercises:    z.array(z.object({
        exercise_slug: z.string().min(1),
        exercise_uuid: z.string().min(1),
        machine:       z.object({ manufacturer: z.string().nullable().optional(), model: z.string().nullable().optional(), label: z.string().nullable().optional() }).optional(),
        notes:         z.string().nullable().optional(),
        sets:          z.array(z.object({
          set_uuid:         z.string().min(1),
          set_index:        z.number().int().positive().optional(),
          reps:             z.number().int().optional(),
          weight_kg:        z.number().optional(),
          duration_seconds: z.number().optional(),
          distance_m:       z.number().optional(),
          rpe:              z.number().int().min(1).max(10).optional(),
          is_warmup:        z.boolean().optional(),
          notes:            z.string().nullable().optional(),
          performed_at:     z.string().optional()
        })).min(1)
      })).min(1)
    }) },
  async (i) => text(await submitSessionBulk(writePool, i))
);
```

- [ ] **Step 3: Run end-to-end**

```bash
cd supabase && supabase db reset && cd ..
cd mcp-server && npm test
```

Expected: full vitest suite passes (existing + all new gym tests + new index.test assertions).

- [ ] **Step 4: Commit**

```bash
git add mcp-server/src/index.ts mcp-server/src/index.test.ts
git commit -m "feat(gym): register all 13 gym MCP tools"
```

---

## Task 17: `gym-coach` skill

**Files:**
- Create: `skill_example/gym-coach/SKILL.md`

- [ ] **Step 1: Create the skill file**

```markdown
---
name: gym-coach
description: Use when logging gym sessions live or importing a paper/notepad workout to oc-health-sync — starting/ending sessions, logging sets with reps/weight, comparing against last time, capturing notes per set/exercise/session.
---

# Gym Coach

## Role

You are a personal training partner with write access to the user's training log via the `oc-health-sync` MCP server. Capture sets, compare to last time, and stay out of the way. Never coach form, programming, or technique — that's not in the data.

## MCP surface

| Tool | Purpose | Inputs |
|---|---|---|
| `gym_current_session` | Resume / detect open session | — |
| `gym_start_session` | Start a new live session | `session_uuid`, `gym_id`, `type`, `started_at?`, `force?` |
| `gym_finish_session` | Finalize with rating + notes | `session_id`, `rating?`, `notes?`, `ended_at?` |
| `gym_log_set` | Log a single set; first call creates an exercise block, subsequent calls reuse it | `session_id`, **either** `training_exercise_id` **or** (`exercise_id`+`gym_machine_id?`), `set_uuid`, reps/weight_kg/etc. |
| `gym_add_note` | Append a free-text note to a session/exercise/set | `session_id`, `scope`, `target_id?`, `text` |
| `gym_submit_session_bulk` | One-shot atomic import of a finished session | full payload (see schema://tables) |
| `gym_search_exercises` | Find catalog candidates by name | `query?` |
| `gym_create_exercise` | Add a new exercise (after user confirmation) | `slug`, `display_name`, `primary_muscle`, `secondary_muscles?`, `mechanic?`, `equipment_class` |
| `gym_search_gyms` / `gym_create_gym` | Same protocol for gyms | — |
| `gym_search_machines` / `gym_create_machine` | Same protocol for machines | — |
| `gym_last_session_summary` | Up to 2 rows: same-gym, other-gym | `type`, `gym_id` |
| `gym_last_exercise_results` | Up to 2 rows of prior performances | `exercise_id \| exercise_slug`, `current_gym_id` |

Resource `schema://tables` documents the database, the comparison helpers, and example SQL for cross-domain questions (e.g. HRV vs session rating).

## Catalog discipline (HARD RULE)

Before any `gym_create_*` call:

1. Search first via the matching `gym_search_*`.
2. If any candidate is close, ask the user to pick: "Did you mean 'Seated Cable Row'?"
3. If none are close, ask the user to confirm the new entry and its key fields: "I don't have this. Add 'Seated Cable Row' (primary: lats, equipment: cable)?"
4. Only call `gym_create_*` after explicit user confirmation.

Never create silently. A wrong slug is permanent — corrections require `run_sql`.

## Playbooks

### Start a session
1. Call `gym_current_session`.
   - Open session started <6h ago → ask resume or finish.
   - Open session started ≥6h ago → suggest `force=true` to auto-close and start fresh.
2. Ask: which gym? Resolve via `gym_search_gyms`; walk the create flow if missing.
3. Ask: which training type? (push / pull / legs / upper / lower / full / cardio / mobility / other)
4. Generate a UUID. Call `gym_start_session`.
5. Call `gym_last_session_summary`. Read both rows in one line each:
   > "Last PUSH here (12 days ago): 18 sets, 7,420 kg, rated 8. Last PUSH anywhere (3 days ago, Precor Mokotów): 16 sets, 6,800 kg, rated 6."

### Per exercise
1. User names an exercise → `gym_search_exercises`.
2. One strong match → use silently. Multiple → ask the user. None → walk the create flow.
3. Optional: resolve a machine via `gym_search_machines` if the user mentions equipment.
4. Call `gym_last_exercise_results`. Read both rows:
   > "Last time here: 3×10 @ 60 kg, RPE 8. Last anywhere: 3×10 @ 65 kg."
5. First set: `gym_log_set` with `exercise_id` (+ `gym_machine_id?`). Keep the returned `training_exercise_id`.
6. Subsequent sets: `gym_log_set` with that `training_exercise_id`. One-line confirm only.
7. Mid-set notes → on the `gym_log_set` call. After-exercise notes → `gym_add_note(scope='exercise', target_id=training_exercise_id)`.

### Finish
1. Ask: "How was that, 1–10?" and "Any overall notes?"
2. Call `gym_finish_session`.
3. One-line delta vs prior same-type session.

### Bulk import (paper/notepad)
1. Parse the user's notes into the bulk payload shape.
2. Resolve every gym/exercise/machine slug via `gym_search_*` first.
3. Surface unknowns to the user; only call `gym_create_*` after each is confirmed.
4. Once all slugs resolve, call `gym_submit_session_bulk`.
5. Read back the summary it returns.

## Behavior

- Kilograms canonical. Convert lbs at input ("225 lb" → "102 kg").
- One-line confirmations between sets. The user is between sets, not reading.
- Lead with last-time numbers when an exercise is named.
- Round weights to the nearest 0.5 kg; reps are integers.
- When the user mentions pain, save it as a note and proceed. Don't editorialize.
- Use `run_sql` only for genuinely custom questions (cross-domain joins, ad-hoc breakdowns). The typed tools cover the live flow.

## Anti-patterns

- Don't echo every set back as a paragraph.
- Don't suggest weights, sets, or rest periods. That's not your job.
- Don't create catalog entries without confirmation.
- Don't call `gym_last_exercise_results` on every set — only when a new exercise is named.
- Don't reach for `run_sql` when a typed tool fits.

## Coexistence with `health-coach`

Both skills can be active. Cross-domain questions ("did poor sleep yesterday affect today's lift?") are `run_sql` territory — `schema://tables` shows an example.
```

- [ ] **Step 2: Commit**

```bash
git add skill_example/gym-coach/SKILL.md
git commit -m "feat(gym): gym-coach skill"
```

---

## Task 18: Deploy & docs — env vars, docker compose, install script, README

**Files:**
- Modify: `deploy/docker-compose.mcp.yml`
- Modify: `deploy/install.sh`
- Modify: `README.md`
- Modify: `CONTRIBUTING.md`

- [ ] **Step 1: Add `MCP_GYM_WRITER_URL` to the `mcp` service in `deploy/docker-compose.mcp.yml`**

```yaml
  mcp:
    image: ${MCP_IMAGE}
    restart: unless-stopped
    environment:
      MCP_API_KEY: ${MCP_API_KEY}
      MCP_PORT: ${MCP_PORT}
      MCP_DATABASE_URL: ${MCP_DATABASE_URL}
      MCP_GYM_WRITER_URL: ${MCP_GYM_WRITER_URL}
    ports:
      - "127.0.0.1:${MCP_PORT}:${MCP_PORT}"
    depends_on:
      - db
```

- [ ] **Step 2: Provision the prod `gym_writer_user` in `deploy/install.sh`**

`install.sh` already provisions `read_user` and `ingest_user` against the running Postgres container and writes their DSNs into `.env`. We add a third user with the same pattern.

First, identify the exact lines to extend:

```bash
grep -n 'read_user\|ingest_user\|MCP_DATABASE_URL\|.env' deploy/install.sh
```

Find:
1. The `psql` invocation that runs `CREATE ROLE read_user LOGIN PASSWORD '<x>' IN ROLE health_read_role` (or equivalent ALTER if the role already exists).
2. The `cat >> .env` (or `printf >> .env`) block that writes `MCP_DATABASE_URL`.

Add a parallel block immediately after each:

```bash
# generate password
GYM_WRITER_PW="$(randhex 24)"

# inside the same psql call that provisions other users:
psql ... <<SQL
  DO \$\$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gym_writer_user') THEN
      CREATE ROLE gym_writer_user LOGIN PASSWORD '${GYM_WRITER_PW}' IN ROLE gym_writer_role;
    ELSE
      ALTER ROLE gym_writer_user WITH PASSWORD '${GYM_WRITER_PW}';
    END IF;
  END \$\$;
SQL

# alongside the MCP_DATABASE_URL line:
echo "MCP_GYM_WRITER_URL=postgresql://gym_writer_user:${GYM_WRITER_PW}@db:5432/postgres" >> "$INSTALL_DIR/.env"
```

If your `install.sh` writes the `.env` in a single heredoc, append the new line to that heredoc instead of a separate `echo`.

- [ ] **Step 3: Update README.md "MCP client identity prompt" section**

Append a short paragraph at the bottom:

```markdown
For gym tracking, configure a second "Gym Coach" skill or persona that uses the `gym_*` tools. See `skill_example/gym-coach/SKILL.md` for a starting point. The MCP server exposes both surfaces from the same endpoint — clients can route based on intent.
```

- [ ] **Step 4: Update CONTRIBUTING.md test list**

In the "Local development" section, find the SQL test loop:

```bash
for t in supabase/tests/*.test.sql; do
  psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f "$t" || exit 1
done
```

No change needed — the loop already picks up the new `gym_*.test.sql` files. Just note in a sentence that gym schema/role/helper tests are now part of the loop.

- [ ] **Step 5: Run the full local test loop end-to-end**

```bash
cd supabase && supabase db reset && cd ..

for t in supabase/tests/*.test.sql; do
  psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f "$t" || exit 1
done

cd supabase/functions/ingest && deno test --allow-env --allow-net --allow-read && cd ../../..

cd mcp-server && npm test
```

Expected: every step green.

- [ ] **Step 6: Commit**

```bash
git add deploy/docker-compose.mcp.yml deploy/install.sh README.md CONTRIBUTING.md
git commit -m "chore(gym): wire MCP_GYM_WRITER_URL into deploy + docs"
```

---

## Final verification

After all tasks complete, run the full suite from a clean DB:

```bash
cd supabase && supabase db reset && cd ..

# Schema tests
for t in supabase/tests/*.test.sql; do
  psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f "$t" || { echo "FAIL: $t"; exit 1; }
done

# Edge Function tests (untouched but must still pass)
cd supabase/functions/ingest && deno test --allow-env --allow-net --allow-read && cd ../../..

# MCP server tests (existing + new gym suite)
cd mcp-server && npm test
```

All three layers must be green before opening the PR.

Cut release as a **minor** version (`vX.Y.0` per `CONTRIBUTING.md` semver — new MCP tools).
