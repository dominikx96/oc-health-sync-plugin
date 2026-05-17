# Diet / Nutrition Tracker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third MCP domain (`diet`) to oc-health-sync that mirrors the ntfy.pl catering plan, logs deviations and ad-hoc meals, and exposes per-day/weekly/energy-balance SQL functions plus a `diet-coach` skill.

**Architecture:** New Postgres tables + a dedicated `diet_writer_role`, new `diet_*` MCP tools writing through a third connection pool (`MCP_DIET_WRITER_URL`), set-returning SQL functions for `run_sql`, and an extended `schema://tables` resource. Catering data is an idempotent provider mirror; user edits live in a separate sparse table so re-sync never clobbers them.

**Tech Stack:** Postgres (Supabase self-host), Node 24 + TypeScript MCP server (`@modelcontextprotocol/*` 2.0.0-alpha.2, `pg`, `zod`), vitest (against local Postgres on `127.0.0.1:54422`), psql schema tests.

**Spec:** `docs/superpowers/specs/2026-05-17-diet-tracker-design.md` (committed `7123ca4`).

**Conventions to follow (verified in-repo):**
- Migrations: idempotent (`CREATE … IF NOT EXISTS`, `CREATE OR REPLACE`, `DO $$ … pg_roles` guards). Timestamped filename prefix.
- Tools: `zod` parse at the boundary, `pool.connect()` + `BEGIN/COMMIT/ROLLBACK` for multi-statement work, idempotent upserts, `text(v)` JSON result wrapper in `index.ts`.
- Tests: `createPool` with `MCP_*_URL` env defaults to `…@127.0.0.1:54422/postgres`; `adminPool` (`postgres:postgres`) does `TRUNCATE … RESTART IDENTITY CASCADE` in `beforeEach`; `vitest run`.
- Run the DB tests exactly as README documents: `cd supabase && supabase db reset && cd ..` then the psql loop, then `cd mcp-server && npm test`.

**Before starting:** create an isolated worktree via `superpowers:using-git-worktrees`. Local Supabase must be running (`cd supabase && supabase start`). After every migration change, run `cd supabase && supabase db reset` before DB-touching tests.

---

## Task 1: DB migration — diet tables + indexes

**Files:**
- Create: `supabase/migrations/20260517000000_init_diet_tables.sql`
- Create: `supabase/tests/diet_schema.test.sql`

- [ ] **Step 1: Write the failing schema test**

Create `supabase/tests/diet_schema.test.sql`:

```sql
-- Diet schema: column presence, the kind / consumed_fraction CHECKs, FKs.
TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day,
         diet_products, diet_subscriptions RESTART IDENTITY CASCADE;

INSERT INTO diet_subscriptions (delivery_diet_id, diet_id, user_diet_name, plan_kcal)
  VALUES (2070357, 3, 'Domino', 2000);
INSERT INTO diet_products (simple_product_id, name, kcal, protein_g, carb_g, fat_g)
  VALUES (606, 'Owsianka', 350, 12, 50, 9);
INSERT INTO diet_catering_meals
  (delivery_item_id, delivery_diet_id, delivery_id, day, meal_slot_key,
   meal_slot_position, simple_product_id, slot_kcal_target, status)
  VALUES (9710456, 2070357, 2125086, DATE '2026-05-18', 'BREAKFAST', 1, 606, 500, 'TO-BE-REALIZED');
INSERT INTO diet_catering_day
  (delivery_diet_id, day, plan_kcal, kcal, protein_g, carb_g, fat_g)
  VALUES (2070357, DATE '2026-05-18', 2000, 1923, 103.7, 217.8, 75.1);

DO $$
DECLARE meal_id_v BIGINT;
BEGIN
  SELECT id INTO meal_id_v FROM diet_catering_meals WHERE delivery_item_id = 9710456;

  -- 1. kind CHECK rejects unknown kinds
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id)
      VALUES ('c-bad-kind', DATE '2026-05-18', 'UTC', 'nibbled', meal_id_v);
    RAISE EXCEPTION 'expected kind CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 2. partial requires consumed_fraction
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id)
      VALUES ('c-bad-partial', DATE '2026-05-18', 'UTC', 'partial', meal_id_v);
    RAISE EXCEPTION 'expected partial-without-fraction CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 3. consumed_fraction must be in (0,1]
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, consumed_fraction)
      VALUES ('c-bad-frac', DATE '2026-05-18', 'UTC', 'partial', meal_id_v, 1.5);
    RAISE EXCEPTION 'expected consumed_fraction CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 4. adhoc requires name + kcal
  BEGIN
    INSERT INTO diet_consumption (uuid, day, tz, kind)
      VALUES ('c-bad-adhoc', DATE '2026-05-18', 'UTC', 'adhoc');
    RAISE EXCEPTION 'expected adhoc-missing-fields CHECK to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- 5. valid rows of every kind insert cleanly
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id) VALUES
    ('c-skip', DATE '2026-05-18', 'UTC', 'skip', meal_id_v);
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, consumed_fraction) VALUES
    ('c-part', DATE '2026-05-18', 'UTC', 'partial', meal_id_v, 0.5);
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, swap_product_id) VALUES
    ('c-swap', DATE '2026-05-18', 'UTC', 'swap', meal_id_v, 606);
  INSERT INTO diet_consumption (uuid, day, tz, kind, name, kcal) VALUES
    ('c-adhoc', DATE '2026-05-18', 'UTC', 'adhoc', 'Banana', 95);
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, notes) VALUES
    ('c-note', DATE '2026-05-18', 'UTC', 'note', meal_id_v, 'tasty');

  -- 6. GIN index columns exist and accept arrays
  UPDATE diet_products SET categories = ARRAY['VEGAN'], allergens = ARRAY['GLUTEN']
    WHERE simple_product_id = 606;

  RAISE NOTICE 'diet_schema.test.sql OK';
END $$;
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd supabase && supabase db reset && psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f tests/diet_schema.test.sql; cd ..`
Expected: FAIL — `relation "diet_subscriptions" does not exist`.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/20260517000000_init_diet_tables.sql` — copy the five `CREATE TABLE IF NOT EXISTS` blocks and the index block **verbatim** from the spec's "Database schema → Tables" and "Indexes" sections (`docs/superpowers/specs/2026-05-17-diet-tracker-design.md`). The DDL there is the source of truth: `diet_subscriptions`, `diet_products`, `diet_catering_meals`, `diet_catering_day`, `diet_consumption` (including the `diet_consumption_kind_fields` CHECK and the per-column CHECKs), then the nine `CREATE INDEX IF NOT EXISTS` statements (including the two `USING GIN` ones).

- [ ] **Step 4: Run the test, expect pass**

Run: `cd supabase && supabase db reset && psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f tests/diet_schema.test.sql; cd ..`
Expected: `NOTICE:  diet_schema.test.sql OK`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260517000000_init_diet_tables.sql supabase/tests/diet_schema.test.sql
git commit -m "feat(diet): tables + indexes migration with schema tests"
```

---

## Task 2: DB migration — diet_writer_role + grants

**Files:**
- Create: `supabase/migrations/20260517000100_diet_roles.sql`
- Create: `supabase/tests/diet_roles.test.sql`

- [ ] **Step 1: Write the failing roles test**

Create `supabase/tests/diet_roles.test.sql`:

```sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diet_writer_role') THEN
    RAISE EXCEPTION 'diet_writer_role missing';
  END IF;

  -- diet_writer_role writes diet tables
  IF NOT has_table_privilege('diet_writer_role', 'public.diet_consumption', 'INSERT') THEN
    RAISE EXCEPTION 'diet_writer_role missing INSERT on diet_consumption';
  END IF;
  IF NOT has_table_privilege('diet_writer_role', 'public.diet_catering_meals', 'UPDATE') THEN
    RAISE EXCEPTION 'diet_writer_role missing UPDATE on diet_catering_meals';
  END IF;

  -- diet_writer_role cannot touch other domains' write surfaces
  IF has_table_privilege('diet_writer_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'diet_writer_role should NOT write health_samples';
  END IF;
  IF has_table_privilege('diet_writer_role', 'public.training_sets', 'INSERT') THEN
    RAISE EXCEPTION 'diet_writer_role should NOT write training_sets';
  END IF;

  -- other writers cannot touch diet_*
  IF has_table_privilege('gym_writer_role', 'public.diet_consumption', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role should NOT write diet_consumption';
  END IF;
  IF has_table_privilege('health_ingest_role', 'public.diet_products', 'INSERT') THEN
    RAISE EXCEPTION 'health_ingest_role should NOT write diet_products';
  END IF;

  -- read role can SELECT diet_* and EXECUTE the functions (functions added in Task 3;
  -- this block only checks SELECT here)
  IF NOT has_table_privilege('health_read_role', 'public.diet_catering_meals', 'SELECT') THEN
    RAISE EXCEPTION 'health_read_role missing SELECT on diet_catering_meals';
  END IF;
  IF has_table_privilege('health_read_role', 'public.diet_consumption', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role should NOT write diet_consumption';
  END IF;

  RAISE NOTICE 'diet_roles.test.sql OK';
END $$;
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd supabase && supabase db reset && psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f tests/diet_roles.test.sql; cd ..`
Expected: FAIL — `diet_writer_role missing`.

- [ ] **Step 3: Write the roles migration**

Create `supabase/migrations/20260517000100_diet_roles.sql` — copy the role-creation `DO $$` block and all `GRANT`/`REVOKE` statements **verbatim** from the spec's "Roles & grants" section, **except** drop the three `GRANT EXECUTE ON FUNCTION diet_*` lines (the functions don't exist until Task 3 — they move to Task 3's migration). Keep: the `CREATE ROLE diet_writer_role NOLOGIN` guard; `GRANT INSERT,UPDATE,SELECT` on the five diet tables + `GRANT USAGE,SELECT ON ALL SEQUENCES`; the cross-domain `REVOKE ALL` (both directions); `GRANT SELECT` on the five diet tables to `health_read_role`.

- [ ] **Step 4: Run the test, expect pass**

Run: `cd supabase && supabase db reset && psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f tests/diet_roles.test.sql; cd ..`
Expected: `NOTICE:  diet_roles.test.sql OK`.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/20260517000100_diet_roles.sql supabase/tests/diet_roles.test.sql
git commit -m "feat(diet): dedicated diet_writer_role with cross-domain isolation"
```

---

## Task 3: DB migration — set-returning functions

**Files:**
- Create: `supabase/migrations/20260517000200_diet_functions.sql`
- Create: `supabase/tests/diet_functions.test.sql`

- [ ] **Step 1: Write the failing functions test**

Create `supabase/tests/diet_functions.test.sql`:

```sql
TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day,
         diet_products, diet_subscriptions RESTART IDENTITY CASCADE;
TRUNCATE health_samples RESTART IDENTITY CASCADE;

INSERT INTO diet_subscriptions (delivery_diet_id, plan_kcal) VALUES (1, 2000);
INSERT INTO diet_products (simple_product_id, name, kcal, protein_g, carb_g, fat_g) VALUES
  (10, 'Breakfast', 500, 30, 50, 20),
  (11, 'Lunch',     700, 40, 70, 25),
  (12, 'Granola alt', 300, 8, 40, 10);
INSERT INTO diet_catering_meals
  (delivery_item_id, delivery_diet_id, delivery_id, day, meal_slot_key, meal_slot_position, simple_product_id, status)
VALUES
  (100, 1, 9, DATE '2026-05-18', 'BREAKFAST', 1, 10, 'REALIZED'),
  (101, 1, 9, DATE '2026-05-18', 'LUNCH',     3, 11, 'REALIZED');
INSERT INTO diet_catering_day (delivery_diet_id, day, plan_kcal, kcal, protein_g, carb_g, fat_g)
  VALUES (1, DATE '2026-05-18', 2000, 1200, 70, 120, 45);

-- Deviations: skip lunch, partial breakfast 0.5
INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, consumed_fraction)
  SELECT 'd-part', DATE '2026-05-18', 'UTC', 'partial', id, 0.5
    FROM diet_catering_meals WHERE delivery_item_id = 100;
INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id)
  SELECT 'd-skip', DATE '2026-05-18', 'UTC', 'skip', id
    FROM diet_catering_meals WHERE delivery_item_id = 101;
-- Ad-hoc snack
INSERT INTO diet_consumption (uuid, day, tz, kind, name, kcal, protein_g)
  VALUES ('d-adhoc', DATE '2026-05-18', 'UTC', 'adhoc', 'Protein bar', 200, 20);
-- Energy out
INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date) VALUES
  ('e1','quantity','HKQuantityTypeIdentifierActiveEnergyBurned', 600,'kcal','2026-05-18T10:00:00Z','2026-05-18T10:00:00Z'),
  ('e2','quantity','HKQuantityTypeIdentifierBasalEnergyBurned', 1500,'kcal','2026-05-18T10:00:00Z','2026-05-18T10:00:00Z');
INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date) VALUES
  ('e3','quantity','HKQuantityTypeIdentifierBasalEnergyBurned', 1600,'kcal','2026-05-19T10:00:00Z','2026-05-19T10:00:00Z');

DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM diet_consumed_day('UTC') WHERE day = DATE '2026-05-18';
  -- breakfast 500*0.5=250 ; lunch skipped 0 ; adhoc 200  => 450 kcal
  IF r.consumed_kcal <> 450 THEN
    RAISE EXCEPTION 'consumed_kcal expected 450 got %', r.consumed_kcal;
  END IF;
  IF r.n_skip <> 1 OR r.n_partial <> 1 OR r.n_adhoc <> 1 THEN
    RAISE EXCEPTION 'deviation counts wrong: skip=% partial=% adhoc=%', r.n_skip, r.n_partial, r.n_adhoc;
  END IF;
  IF r.n_planned <> 2 THEN
    RAISE EXCEPTION 'n_planned expected 2 (total catering slots) got %', r.n_planned;
  END IF;
  IF r.plan_target_kcal <> 2000 OR r.planned_kcal <> 1200 THEN
    RAISE EXCEPTION 'plan numbers wrong: target=% planned=%', r.plan_target_kcal, r.planned_kcal;
  END IF;

  SELECT * INTO r FROM diet_energy_balance('UTC') WHERE day = DATE '2026-05-18';
  IF r.total_out_kcal <> 2100 OR r.intake_kcal <> 450 OR r.net_kcal <> -1650 THEN
    RAISE EXCEPTION 'energy balance wrong: out=% intake=% net=%', r.total_out_kcal, r.intake_kcal, r.net_kcal;
  END IF;

  PERFORM 1 FROM diet_weekly('UTC') WHERE consumed_kcal = 450;
  IF NOT FOUND THEN RAISE EXCEPTION 'diet_weekly did not roll up the day'; END IF;

  -- swap precedence: latest non-deleted deviation wins
  INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, swap_product_id)
    SELECT 'd-swap', DATE '2026-05-18', 'UTC', 'swap', id, 12
      FROM diet_catering_meals WHERE delivery_item_id = 100;
  -- now breakfast = granola alt (300) instead of 500*0.5; lunch 0; adhoc 200 => 500
  SELECT * INTO r FROM diet_consumed_day('UTC') WHERE day = DATE '2026-05-18';
  IF r.consumed_kcal <> 500 THEN
    RAISE EXCEPTION 'swap precedence wrong: expected 500 got %', r.consumed_kcal;
  END IF;

  -- soft-deleted deviations are ignored
  UPDATE diet_consumption SET deleted_at = now() WHERE uuid IN ('d-swap','d-part');
  SELECT * INTO r FROM diet_consumed_day('UTC') WHERE day = DATE '2026-05-18';
  -- breakfast back to full 500 ; lunch 0 ; adhoc 200 => 700
  IF r.consumed_kcal <> 700 THEN
    RAISE EXCEPTION 'soft-delete handling wrong: expected 700 got %', r.consumed_kcal;
  END IF;

  SELECT * INTO r FROM diet_energy_balance('UTC') WHERE day = DATE '2026-05-19';
  IF r.intake_kcal <> 0 OR r.total_out_kcal <> 1600 OR r.net_kcal <> -1600 THEN
    RAISE EXCEPTION 'exercise-only day wrong: intake=% out=% net=%', r.intake_kcal, r.total_out_kcal, r.net_kcal;
  END IF;

  RAISE NOTICE 'diet_functions.test.sql OK';
END $$;
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd supabase && supabase db reset && psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f tests/diet_functions.test.sql; cd ..`
Expected: FAIL — `function diet_consumed_day(unknown) does not exist`.

- [ ] **Step 3: Write the functions migration**

Create `supabase/migrations/20260517000200_diet_functions.sql` with these three `CREATE OR REPLACE FUNCTION`s, then the three `GRANT EXECUTE` lines.

```sql
CREATE OR REPLACE FUNCTION diet_consumed_day(p_tz TEXT)
RETURNS TABLE (
  day DATE, delivery_diet_id BIGINT, plan_target_kcal INT,
  planned_kcal NUMERIC, planned_protein_g NUMERIC, planned_carb_g NUMERIC,
  planned_fat_g NUMERIC, planned_fiber_g NUMERIC, planned_sugar_g NUMERIC, planned_salt_g NUMERIC,
  consumed_kcal NUMERIC, consumed_protein_g NUMERIC, consumed_carb_g NUMERIC,
  consumed_fat_g NUMERIC, consumed_saturated_fat_g NUMERIC, consumed_fiber_g NUMERIC,
  consumed_sugar_g NUMERIC, consumed_salt_g NUMERIC,
  n_planned INT, n_skip INT, n_partial INT, n_swap INT, n_adhoc INT
) LANGUAGE sql STABLE AS $$
WITH days AS (
  SELECT DISTINCT day FROM diet_catering_meals WHERE deleted_at IS NULL
  UNION
  SELECT DISTINCT day FROM diet_consumption    WHERE deleted_at IS NULL
),
meal_dev AS (
  SELECT m.id AS meal_id, m.day, m.simple_product_id,
         dv.kind, dv.consumed_fraction, dv.swap_product_id
    FROM diet_catering_meals m
    LEFT JOIN LATERAL (
      SELECT c.kind, c.consumed_fraction, c.swap_product_id
        FROM diet_consumption c
       WHERE c.catering_meal_id = m.id AND c.deleted_at IS NULL
         AND c.kind IN ('skip','partial','swap')
       ORDER BY c.updated_at DESC, c.id DESC LIMIT 1
    ) dv ON true
   WHERE m.deleted_at IS NULL
),
meal_nutr AS (
  SELECT md.day, md.kind,
         CASE md.kind WHEN 'skip' THEN 0
                      WHEN 'partial' THEN COALESCE(md.consumed_fraction,0)
                      ELSE 1 END AS mult,
         CASE WHEN md.kind='swap' THEN sp.kcal            ELSE p.kcal            END AS kcal,
         CASE WHEN md.kind='swap' THEN sp.protein_g       ELSE p.protein_g       END AS protein_g,
         CASE WHEN md.kind='swap' THEN sp.carb_g          ELSE p.carb_g          END AS carb_g,
         CASE WHEN md.kind='swap' THEN sp.fat_g           ELSE p.fat_g           END AS fat_g,
         CASE WHEN md.kind='swap' THEN sp.saturated_fat_g ELSE p.saturated_fat_g END AS saturated_fat_g,
         CASE WHEN md.kind='swap' THEN sp.fiber_g         ELSE p.fiber_g         END AS fiber_g,
         CASE WHEN md.kind='swap' THEN sp.sugar_g         ELSE p.sugar_g         END AS sugar_g,
         CASE WHEN md.kind='swap' THEN sp.salt_g          ELSE p.salt_g          END AS salt_g
    FROM meal_dev md
    LEFT JOIN diet_products p  ON p.simple_product_id  = md.simple_product_id
    LEFT JOIN diet_products sp ON sp.simple_product_id = md.swap_product_id
),
meal_agg AS (
  SELECT day,
         SUM(COALESCE(kcal,0)*mult)            AS kcal,
         SUM(COALESCE(protein_g,0)*mult)       AS protein_g,
         SUM(COALESCE(carb_g,0)*mult)          AS carb_g,
         SUM(COALESCE(fat_g,0)*mult)           AS fat_g,
         SUM(COALESCE(saturated_fat_g,0)*mult) AS saturated_fat_g,
         SUM(COALESCE(fiber_g,0)*mult)         AS fiber_g,
         SUM(COALESCE(sugar_g,0)*mult)         AS sugar_g,
         SUM(COALESCE(salt_g,0)*mult)          AS salt_g,
         COUNT(*)                                  AS n_planned,
         COUNT(*) FILTER (WHERE kind='skip')        AS n_skip,
         COUNT(*) FILTER (WHERE kind='partial')     AS n_partial,
         COUNT(*) FILTER (WHERE kind='swap')        AS n_swap
    FROM meal_nutr GROUP BY day
),
adhoc_agg AS (
  SELECT day,
         SUM(COALESCE(kcal,0))            AS kcal,
         SUM(COALESCE(protein_g,0))       AS protein_g,
         SUM(COALESCE(carb_g,0))          AS carb_g,
         SUM(COALESCE(fat_g,0))           AS fat_g,
         SUM(COALESCE(saturated_fat_g,0)) AS saturated_fat_g,
         SUM(COALESCE(fiber_g,0))         AS fiber_g,
         SUM(COALESCE(sugar_g,0))         AS sugar_g,
         SUM(COALESCE(salt_g,0))          AS salt_g,
         COUNT(*)                          AS n_adhoc
    FROM diet_consumption
   WHERE kind='adhoc' AND deleted_at IS NULL
   GROUP BY day
),
cday AS (
  SELECT day, MIN(delivery_diet_id) AS delivery_diet_id,
         SUM(plan_kcal)::int AS plan_target_kcal,
         SUM(kcal) AS kcal, SUM(protein_g) AS protein_g, SUM(carb_g) AS carb_g,
         SUM(fat_g) AS fat_g, SUM(fiber_g) AS fiber_g, SUM(sugar_g) AS sugar_g, SUM(salt_g) AS salt_g
    FROM diet_catering_day GROUP BY day
)
SELECT d.day, cday.delivery_diet_id, cday.plan_target_kcal,
       cday.kcal, cday.protein_g, cday.carb_g, cday.fat_g, cday.fiber_g, cday.sugar_g, cday.salt_g,
       COALESCE(ma.kcal,0)+COALESCE(aa.kcal,0)                       AS consumed_kcal,
       COALESCE(ma.protein_g,0)+COALESCE(aa.protein_g,0)             AS consumed_protein_g,
       COALESCE(ma.carb_g,0)+COALESCE(aa.carb_g,0)                   AS consumed_carb_g,
       COALESCE(ma.fat_g,0)+COALESCE(aa.fat_g,0)                     AS consumed_fat_g,
       COALESCE(ma.saturated_fat_g,0)+COALESCE(aa.saturated_fat_g,0) AS consumed_saturated_fat_g,
       COALESCE(ma.fiber_g,0)+COALESCE(aa.fiber_g,0)                 AS consumed_fiber_g,
       COALESCE(ma.sugar_g,0)+COALESCE(aa.sugar_g,0)                 AS consumed_sugar_g,
       COALESCE(ma.salt_g,0)+COALESCE(aa.salt_g,0)                   AS consumed_salt_g,
       COALESCE(ma.n_planned,0)::int, COALESCE(ma.n_skip,0)::int,
       COALESCE(ma.n_partial,0)::int, COALESCE(ma.n_swap,0)::int,
       COALESCE(aa.n_adhoc,0)::int
  FROM days d
  LEFT JOIN meal_agg  ma ON ma.day  = d.day
  LEFT JOIN adhoc_agg aa ON aa.day  = d.day
  LEFT JOIN cday         ON cday.day = d.day
 ORDER BY d.day;
$$;

CREATE OR REPLACE FUNCTION diet_weekly(p_tz TEXT)
RETURNS TABLE (
  week_start DATE, days_with_delivery INT,
  plan_target_kcal NUMERIC, planned_kcal NUMERIC, consumed_kcal NUMERIC,
  consumed_protein_g NUMERIC, consumed_carb_g NUMERIC, consumed_fat_g NUMERIC,
  n_skip INT, n_partial INT, n_swap INT, n_adhoc INT
) LANGUAGE sql STABLE AS $$
  SELECT date_trunc('week', day)::date AS week_start,
         COUNT(*) FILTER (WHERE delivery_diet_id IS NOT NULL)::int,
         SUM(plan_target_kcal), SUM(planned_kcal), SUM(consumed_kcal),
         SUM(consumed_protein_g), SUM(consumed_carb_g), SUM(consumed_fat_g),
         SUM(n_skip)::int, SUM(n_partial)::int, SUM(n_swap)::int, SUM(n_adhoc)::int
    FROM diet_consumed_day(p_tz)
   GROUP BY 1 ORDER BY 1;
$$;

CREATE OR REPLACE FUNCTION diet_energy_balance(p_tz TEXT)
RETURNS TABLE (
  day DATE, intake_kcal NUMERIC, active_kcal NUMERIC,
  basal_kcal NUMERIC, total_out_kcal NUMERIC, net_kcal NUMERIC
) LANGUAGE sql STABLE AS $$
  WITH intake AS ( SELECT day, consumed_kcal FROM diet_consumed_day(p_tz) ),
  energy AS (
    SELECT (start_date AT TIME ZONE p_tz)::date AS day,
           SUM(value) FILTER (WHERE data_type='HKQuantityTypeIdentifierActiveEnergyBurned') AS active_kcal,
           SUM(value) FILTER (WHERE data_type='HKQuantityTypeIdentifierBasalEnergyBurned')  AS basal_kcal
      FROM health_samples
     WHERE deleted_at IS NULL
       AND data_type IN ('HKQuantityTypeIdentifierActiveEnergyBurned',
                          'HKQuantityTypeIdentifierBasalEnergyBurned')
     GROUP BY 1
  )
  SELECT COALESCE(i.day, e.day),
         COALESCE(i.consumed_kcal,0),
         COALESCE(e.active_kcal,0),
         COALESCE(e.basal_kcal,0),
         COALESCE(e.active_kcal,0)+COALESCE(e.basal_kcal,0),
         COALESCE(i.consumed_kcal,0)-(COALESCE(e.active_kcal,0)+COALESCE(e.basal_kcal,0))
    FROM intake i FULL OUTER JOIN energy e ON e.day = i.day
   ORDER BY 1;
$$;

GRANT EXECUTE ON FUNCTION diet_consumed_day(TEXT)   TO health_read_role, diet_writer_role;
GRANT EXECUTE ON FUNCTION diet_weekly(TEXT)         TO health_read_role, diet_writer_role;
GRANT EXECUTE ON FUNCTION diet_energy_balance(TEXT) TO health_read_role, diet_writer_role;
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd supabase && supabase db reset && psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f tests/diet_functions.test.sql; cd ..`
Expected: `NOTICE:  diet_functions.test.sql OK`.

- [ ] **Step 5: Run the full psql suite (no regressions)**

Run: `cd supabase && supabase db reset && for t in tests/*.test.sql; do psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f "$t" || exit 1; done; cd ..`
Expected: every file prints its `… OK` notice; exit 0.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/20260517000200_diet_functions.sql supabase/tests/diet_functions.test.sql
git commit -m "feat(diet): diet_consumed_day/diet_weekly/diet_energy_balance functions"
```

---

## Task 4: Local-dev login user (`diet_writer_user`) in seed.sql

**Files:**
- Modify: `supabase/seed.sql`

- [ ] **Step 1: Append the diet writer block**

Add to the end of `supabase/seed.sql`:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diet_writer_user') THEN
    CREATE ROLE diet_writer_user LOGIN PASSWORD 'diet_writer_pw' IN ROLE diet_writer_role;
  END IF;
END $$;

-- Local-dev convenience: allow diet_writer_user to TRUNCATE diet tables for tests.
GRANT TRUNCATE ON diet_subscriptions, diet_products, diet_catering_meals,
                  diet_catering_day, diet_consumption
  TO diet_writer_user;
```

- [ ] **Step 2: Apply and verify the login works**

Run: `cd supabase && supabase db reset && cd .. && psql 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres' -c 'SELECT 1;'`
Expected: prints `1`, exit 0 (the login user exists and can connect).

- [ ] **Step 3: Commit**

```bash
git add supabase/seed.sql
git commit -m "feat(diet): local-dev diet_writer_user in seed.sql"
```

---

## Task 5: Sanitized test fixtures

**Files:**
- Create: `mcp-server/test/fixtures/ntfy-deliveries.json`
- Create: `mcp-server/test/fixtures/ntfy-delivery-diets.json`

- [ ] **Step 1: Generate sanitized fixtures from the gitignored captures**

The raw captures `ntfy-deliveries-2026-05-18.json` and `ntfy-delivery-diets.json` are at repo root (gitignored, contain PII). Strip PII completely (user/address ids, prices, trace_id, and the entire `addresses` include which is fully redacted — not consumed by any diet code); `user_diet_name` is intentionally kept as it is a generic non-identifying diet label that Task 6's test asserts.

Run:
```bash
mkdir -p mcp-server/test/fixtures
jq '
  (.trace_id) = "00000000-0000-0000-0000-000000000000"
  | (.data.results[]?.user_id) = 1
  | (.data.results[]?.address_id) = 1
  | (.data.results[]?.price_before_discount) = 0
  | (.data.results[]?.price_after_discount) = 0
  | (.data.results[]?.paid_with_moneybox) = 0
  | (.data.results[]?.paid_with_points) = 0
  | (.data.results[]?.returned_to_moneybox) = 0
  | (.data.results[]?.discount) = 0
  | (.data.includes.delivery_items[]?.paid_with_moneybox) = 0
  | (.data.includes.delivery_items[]?.paid_with_points) = 0
  | (.data.includes.delivery_items[]?.price_before_discount) = 0
  | (.data.includes.delivery_items[]?.price_after_discount) = 0
  | (.data.includes.addresses) |= ( (. // []) | map(
        reduce (paths(strings)) as $p (.; setpath($p; "REDACTED"))
        | .id = 1
        | .user_id = 1
        | (if has("delivery_times") and (.delivery_times|type=="array")
             then .delivery_times |= map(.id = 1) else . end)
    ))
' \
  ntfy-deliveries-2026-05-18.json > mcp-server/test/fixtures/ntfy-deliveries.json

jq '
  (.trace_id) = "00000000-0000-0000-0000-000000000000"
  | (.data.results[]?.user_id) = 1
  | (.data.results[]?.address_ids) = [1]
  | (if (.data.includes? and .data.includes.addresses?)
       then (.data.includes.addresses) |= map(
              reduce (paths(strings)) as $p (.; setpath($p; "REDACTED")) | .id = 1 | .user_id = 1)
       else . end)
' \
  ntfy-delivery-diets.json > mcp-server/test/fixtures/ntfy-delivery-diets.json
```

- [ ] **Step 2: Verify PII is gone but structure intact**

Run:
```bash
grep -c 41070 mcp-server/test/fixtures/*.json; \
jq '.data.includes.simple_products | length' mcp-server/test/fixtures/ntfy-deliveries.json; \
jq '.data.results[0].id' mcp-server/test/fixtures/ntfy-delivery-diets.json
```
Expected: `grep -c` prints `0` for both files (no `user_id` 41070 left); product count `45`; delivery-diet id `2070357` (provider business id is fine to keep — it's not PII).

- [ ] **Step 3: Commit**

```bash
git add mcp-server/test/fixtures/ntfy-deliveries.json mcp-server/test/fixtures/ntfy-delivery-diets.json
git commit -m "test(diet): sanitized ntfy.pl fixtures"
```

---

## Task 6: `diet_sync_subscriptions` + `diet_sync_catering_day` tools

**Files:**
- Create: `mcp-server/src/tools/diet/sync.ts`
- Test: `mcp-server/src/tools/diet/sync.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/src/tools/diet/sync.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../db.js';
import { syncSubscriptions, syncCateringDay } from './sync.js';

const writePool = createPool(process.env.MCP_DIET_WRITER_URL ?? 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

const fx = (n: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${n}`, import.meta.url)), 'utf8'));

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day, diet_products, diet_subscriptions RESTART IDENTITY CASCADE');
});

describe('syncSubscriptions', () => {
  it('upserts a subscription and is idempotent', async () => {
    const r1 = await syncSubscriptions(writePool, fx('ntfy-delivery-diets.json'));
    expect(r1.upserted).toBeGreaterThan(0);
    const r2 = await syncSubscriptions(writePool, fx('ntfy-delivery-diets.json'));
    expect(r2.upserted).toBe(r1.upserted);
    const row = await adminPool.query(`SELECT user_diet_name, plan_kcal FROM diet_subscriptions WHERE delivery_diet_id = 2070357`);
    expect(row.rows[0].user_diet_name).toBe('Domino');
    expect(row.rows[0].plan_kcal).toBe(2000);
  });
});

describe('syncCateringDay', () => {
  it('parses the deliveries payload into products/meals/day', async () => {
    const r = await syncCateringDay(writePool, fx('ntfy-deliveries.json'));
    expect(r.no_delivery).toBe(false);
    expect(r.products).toBe(45);
    expect(r.meals).toBe(5);
    const meals = await adminPool.query(`SELECT meal_slot_key, simple_product_id FROM diet_catering_meals ORDER BY meal_slot_position`);
    expect(meals.rows).toHaveLength(5);
    expect(meals.rows[0].meal_slot_key).toBe('BREAKFAST');
    const day = await adminPool.query(`SELECT plan_kcal, kcal, protein_g FROM diet_catering_day WHERE day = DATE '2026-05-18'`);
    expect(Number(day.rows[0].plan_kcal)).toBe(2000);
    expect(Number(day.rows[0].kcal)).toBe(1923);
    expect(Number(day.rows[0].protein_g)).toBeCloseTo(103.7, 1);
  });

  it('is idempotent (no duplicate meals on re-run)', async () => {
    await syncCateringDay(writePool, fx('ntfy-deliveries.json'));
    await syncCateringDay(writePool, fx('ntfy-deliveries.json'));
    const n = await adminPool.query(`SELECT count(*)::int AS c FROM diet_catering_meals`);
    expect(n.rows[0].c).toBe(5);
  });

  it('no-ops on an empty (no-delivery) payload', async () => {
    const r = await syncCateringDay(writePool, { data: { result_count: 0, results: [], includes: {}, aggregates: [] } });
    expect(r).toEqual({ products: 0, meals: 0, day: null, no_delivery: true, warnings: [] });
  });

  it('stubs a missing product and reports a warning', async () => {
    const p = fx('ntfy-deliveries.json');
    p.data.includes.simple_products = p.data.includes.simple_products.filter((sp: any) => sp.id !== p.data.includes.delivery_items[0].simple_product_id);
    const r = await syncCateringDay(writePool, p);
    expect(r.warnings.length).toBeGreaterThan(0);
    const stub = await adminPool.query(`SELECT name, kcal FROM diet_products WHERE simple_product_id = $1`, [p.data.includes.delivery_items[0].simple_product_id]);
    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0].kcal).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd mcp-server && npm test -- src/tools/diet/sync.test.ts; cd ..`
Expected: FAIL — cannot resolve `./sync.js`.

- [ ] **Step 3: Implement `sync.ts`**

Create `mcp-server/src/tools/diet/sync.ts`:

```ts
import type { Pool } from '../../db.js';

interface Envelope { data?: { result_count?: number; results?: any[]; includes?: any; aggregates?: any[] } }

export interface SyncSubscriptionsResult { upserted: number }

export async function syncSubscriptions(pool: Pool, raw: unknown): Promise<SyncSubscriptionsResult> {
  const env = raw as Envelope;
  const rows = env?.data?.results;
  if (!Array.isArray(rows)) throw new Error('invalid payload: data.results is not an array');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let upserted = 0;
    for (const r of rows) {
      await client.query(
        `INSERT INTO diet_subscriptions
           (delivery_diet_id, diet_id, user_diet_name, plan_kcal,
            first_delivery_day, last_delivery_day, status, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (delivery_diet_id) DO UPDATE SET
           diet_id            = EXCLUDED.diet_id,
           user_diet_name     = EXCLUDED.user_diet_name,
           plan_kcal          = EXCLUDED.plan_kcal,
           first_delivery_day = EXCLUDED.first_delivery_day,
           last_delivery_day  = EXCLUDED.last_delivery_day,
           status             = EXCLUDED.status,
           raw                = EXCLUDED.raw,
           updated_at         = now()`,
        [r.id, r.diet_id ?? null, r.user_diet_name ?? null, r.kcal ?? null,
         r.first_delivery_day ?? null, r.last_delivery_day ?? null, r.status ?? null, r]
      );
      upserted += 1;
    }
    await client.query('COMMIT');
    return { upserted };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface SyncCateringDayResult {
  products: number; meals: number; day: string | null;
  no_delivery: boolean; warnings: string[];
}

const NUTR = (sp: any) => ({
  kcal: sp?.calorific ?? null, kj: sp?.kj ?? null,
  protein_g: sp?.protein ?? null, carb_g: sp?.carb ?? null, fat_g: sp?.fat ?? null,
  saturated_fat_g: sp?.saturated_fat ?? null, fiber_g: sp?.fiber ?? null,
  sugar_g: sp?.sugar ?? null, salt_g: sp?.salt ?? null,
  protein_pct: sp?.protein_percent ?? null, carb_pct: sp?.carb_percent ?? null,
  fat_pct: sp?.fat_percent ?? null
});

export async function syncCateringDay(pool: Pool, raw: unknown): Promise<SyncCateringDayResult> {
  const env = raw as Envelope;
  const data = env?.data;
  if (!data) throw new Error('invalid payload: missing data');
  const results = Array.isArray(data.results) ? data.results : [];
  if ((data.result_count ?? results.length) === 0 || results.length === 0) {
    return { products: 0, meals: 0, day: null, no_delivery: true, warnings: [] };
  }

  const delivery = results[0];
  const inc = data.includes ?? {};
  const items: any[]   = Array.isArray(inc.delivery_items) ? inc.delivery_items : [];
  const products: any[] = Array.isArray(inc.simple_products) ? inc.simple_products : [];
  const dvMeals: any[]  = Array.isArray(inc.diet_variant_meals) ? inc.diet_variant_meals : [];
  const dvTypes: any[]  = Array.isArray(inc.diet_variant_meal_types) ? inc.diet_variant_meal_types : [];
  const alts: any[]     = Array.isArray(inc.alternative_meals) ? inc.alternative_meals : [];
  const aggregates: any[] = Array.isArray(data.aggregates) ? data.aggregates : [];

  const day: string = delivery.date;
  const deliveryDietId: number | undefined =
    items.find((i) => i.delivery_diet_id != null)?.delivery_diet_id;
  if (deliveryDietId == null) throw new Error('cannot determine delivery_diet_id from payload');

  const typeById = new Map<number, any>(dvTypes.map((t) => [t.id, t]));
  const dvMealById = new Map<number, any>(dvMeals.map((m) => [m.id, m]));
  const altByItem = new Map<number, number[]>(
    alts.map((a) => [a.delivery_item_id, Array.isArray(a.simple_product_ids) ? a.simple_product_ids : []])
  );
  const productById = new Map<number, any>(products.map((p) => [p.id, p]));
  const warnings: string[] = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FK safety: ensure a subscription row exists (stub if syncSubscriptions wasn't called).
    await client.query(
      `INSERT INTO diet_subscriptions (delivery_diet_id) VALUES ($1)
         ON CONFLICT (delivery_diet_id) DO NOTHING`,
      [deliveryDietId]
    );

    // Products (crc32-gated).
    let productCount = 0;
    const upsertProduct = async (sp: any, stub = false) => {
      const n = NUTR(sp);
      await client.query(
        `INSERT INTO diet_products
           (simple_product_id, name, composition, weight_g, kind,
            kcal, kj, protein_g, carb_g, fat_g, saturated_fat_g, fiber_g, sugar_g, salt_g,
            protein_pct, carb_pct, fat_pct, categories, allergens, images, crc32, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
         ON CONFLICT (simple_product_id) DO UPDATE SET
           name=EXCLUDED.name, composition=EXCLUDED.composition, weight_g=EXCLUDED.weight_g,
           kind=EXCLUDED.kind, kcal=EXCLUDED.kcal, kj=EXCLUDED.kj, protein_g=EXCLUDED.protein_g,
           carb_g=EXCLUDED.carb_g, fat_g=EXCLUDED.fat_g, saturated_fat_g=EXCLUDED.saturated_fat_g,
           fiber_g=EXCLUDED.fiber_g, sugar_g=EXCLUDED.sugar_g, salt_g=EXCLUDED.salt_g,
           protein_pct=EXCLUDED.protein_pct, carb_pct=EXCLUDED.carb_pct, fat_pct=EXCLUDED.fat_pct,
           categories=EXCLUDED.categories, allergens=EXCLUDED.allergens, images=EXCLUDED.images,
           crc32=EXCLUDED.crc32, raw=EXCLUDED.raw, updated_at=now()
         WHERE diet_products.crc32 IS DISTINCT FROM EXCLUDED.crc32`,
        [
          sp.id, sp.name ?? (stub ? `product ${sp.id}` : null), sp.composition ?? null,
          sp.weight ?? null, sp.kind ?? null,
          n.kcal, n.kj, n.protein_g, n.carb_g, n.fat_g, n.saturated_fat_g, n.fiber_g, n.sugar_g, n.salt_g,
          n.protein_pct, n.carb_pct, n.fat_pct,
          (sp.categories ?? []).map((c: any) => c?.tag_value?.key).filter(Boolean),
          (sp.allergens ?? []).map((a: any) => a?.tag_value?.key).filter(Boolean),
          sp.images ? JSON.stringify(sp.images) : null,
          stub ? null : (sp.crc32 ?? null), JSON.stringify(sp)
        ]
      );
      productCount += 1;
    };
    for (const sp of products) await upsertProduct(sp);

    // Meals.
    let mealCount = 0;
    for (const it of items) {
      if (it.simple_product_id != null && !productById.has(it.simple_product_id)) {
        warnings.push(`simple_product_id ${it.simple_product_id} missing from includes — stubbed`);
        await upsertProduct({ id: it.simple_product_id }, true);
      }
      const dvm  = dvMealById.get(it.diet_variant_meal_id);
      const slot = dvm ? typeById.get(dvm.diet_variant_meal_type_id) : undefined;
      await client.query(
        `INSERT INTO diet_catering_meals
           (delivery_item_id, delivery_diet_id, delivery_id, day, diet_variant_meal_id,
            meal_slot_key, meal_slot_name, meal_slot_position, simple_product_id,
            slot_kcal_target, status, alternative_product_ids, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (delivery_item_id) DO UPDATE SET
           delivery_diet_id=EXCLUDED.delivery_diet_id, delivery_id=EXCLUDED.delivery_id,
           day=EXCLUDED.day, diet_variant_meal_id=EXCLUDED.diet_variant_meal_id,
           meal_slot_key=EXCLUDED.meal_slot_key, meal_slot_name=EXCLUDED.meal_slot_name,
           meal_slot_position=EXCLUDED.meal_slot_position, simple_product_id=EXCLUDED.simple_product_id,
           slot_kcal_target=EXCLUDED.slot_kcal_target, status=EXCLUDED.status,
           alternative_product_ids=EXCLUDED.alternative_product_ids, raw=EXCLUDED.raw, updated_at=now()`,
        [
          it.id, it.delivery_diet_id ?? deliveryDietId, it.delivery_id ?? delivery.id, day,
          it.diet_variant_meal_id ?? null,
          slot?.meal_name?.key ?? null, slot?.meal_name?.value ?? null, slot?.position ?? null,
          it.simple_product_id ?? null, dvm?.kcal ?? null, it.status ?? null,
          altByItem.get(it.id) ?? [], JSON.stringify(it)
        ]
      );
      mealCount += 1;
    }

    // Day aggregate (pivot the aggregates array by name).
    const agg = new Map<string, number>(aggregates.map((a) => [a.name, a.value]));
    await client.query(
      `INSERT INTO diet_catering_day
         (delivery_diet_id, day, plan_kcal, kcal, kj, protein_g, carb_g, fat_g,
          saturated_fat_g, fiber_g, sugar_g, salt_g, protein_pct, carb_pct, fat_pct, raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (delivery_diet_id, day) DO UPDATE SET
         plan_kcal=EXCLUDED.plan_kcal, kcal=EXCLUDED.kcal, kj=EXCLUDED.kj,
         protein_g=EXCLUDED.protein_g, carb_g=EXCLUDED.carb_g, fat_g=EXCLUDED.fat_g,
         saturated_fat_g=EXCLUDED.saturated_fat_g, fiber_g=EXCLUDED.fiber_g,
         sugar_g=EXCLUDED.sugar_g, salt_g=EXCLUDED.salt_g, protein_pct=EXCLUDED.protein_pct,
         carb_pct=EXCLUDED.carb_pct, fat_pct=EXCLUDED.fat_pct, raw=EXCLUDED.raw, updated_at=now()`,
      [
        deliveryDietId, day,
        agg.get('calorific_kcal_offer') ?? null, agg.get('calorific_kcal') ?? null,
        agg.get('calorific_kj') ?? null, agg.get('protein') ?? null, agg.get('carb') ?? null,
        agg.get('fat') ?? null, agg.get('saturated_fat') ?? null, agg.get('fiber') ?? null,
        agg.get('sugar') ?? null, agg.get('salt') ?? null, agg.get('protein_percent') ?? null,
        agg.get('carb_percent') ?? null, agg.get('fat_percent') ?? null,
        JSON.stringify(aggregates)
      ]
    );

    await client.query('COMMIT');
    return { products: productCount, meals: mealCount, day, no_delivery: false, warnings };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd supabase && supabase db reset && cd ../mcp-server && npm test -- src/tools/diet/sync.test.ts; cd ..`
Expected: all 5 `sync` tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/diet/sync.ts mcp-server/src/tools/diet/sync.test.ts
git commit -m "feat(diet): diet_sync_subscriptions + diet_sync_catering_day"
```

---

## Task 7: `diet_log_meal` + `diet_log_deviation` tools

**Files:**
- Create: `mcp-server/src/tools/diet/log.ts`
- Test: `mcp-server/src/tools/diet/log.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/src/tools/diet/log.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { logMeal, logDeviation } from './log.js';

const writePool = createPool(process.env.MCP_DIET_WRITER_URL ?? 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day, diet_products, diet_subscriptions RESTART IDENTITY CASCADE');
  await adminPool.query(`INSERT INTO diet_subscriptions (delivery_diet_id) VALUES (1)`);
  await adminPool.query(`INSERT INTO diet_products (simple_product_id, name, kcal) VALUES (10,'Breakfast',500)`);
  await adminPool.query(`INSERT INTO diet_catering_meals
    (delivery_item_id, delivery_diet_id, delivery_id, day, meal_slot_key, meal_slot_position, simple_product_id, status)
    VALUES (100, 1, 9, DATE '2026-05-18', 'BREAKFAST', 1, 10, 'REALIZED')`);
});

describe('logMeal', () => {
  it('inserts an adhoc row and is idempotent on uuid', async () => {
    const r1 = await logMeal(writePool, { uuid: 'm1', date: '2026-05-18', tz: 'UTC', name: 'Banana', kcal: 95, source: 'web_research' });
    expect(r1.id).toBeGreaterThan(0);
    const r2 = await logMeal(writePool, { uuid: 'm1', date: '2026-05-18', tz: 'UTC', name: 'Banana', kcal: 95, source: 'web_research' });
    expect(r2.id).toBe(r1.id);
    const n = await adminPool.query(`SELECT count(*)::int c FROM diet_consumption WHERE kind='adhoc'`);
    expect(n.rows[0].c).toBe(1);
  });

  it('rejects missing kcal', async () => {
    await expect(logMeal(writePool, { uuid: 'm2', name: 'X' } as any)).rejects.toThrow(/kcal/);
  });
});

describe('logDeviation', () => {
  it('resolves catering_meal_id from (day, meal_slot_key) for a partial', async () => {
    const r = await logDeviation(writePool, { uuid: 'd1', kind: 'partial', day: '2026-05-18', meal_slot_key: 'BREAKFAST', consumed_fraction: 0.5 });
    const row = await adminPool.query(`SELECT catering_meal_id, day, consumed_fraction FROM diet_consumption WHERE uuid='d1'`);
    expect(row.rows[0].catering_meal_id).not.toBeNull();
    expect(row.rows[0].day.toISOString().slice(0,10)).toBe('2026-05-18');
    expect(Number(row.rows[0].consumed_fraction)).toBe(0.5);
    expect(r.id).toBeGreaterThan(0);
  });

  it('errors when the slot cannot be resolved', async () => {
    await expect(logDeviation(writePool, { uuid: 'd2', kind: 'skip', day: '2026-05-18', meal_slot_key: 'DINNER' }))
      .rejects.toThrow(/no catering meal/i);
  });

  it('partial requires consumed_fraction', async () => {
    await expect(logDeviation(writePool, { uuid: 'd3', kind: 'partial', day: '2026-05-18', meal_slot_key: 'BREAKFAST' }))
      .rejects.toThrow(/consumed_fraction/);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd mcp-server && npm test -- src/tools/diet/log.test.ts; cd ..`
Expected: FAIL — cannot resolve `./log.js`.

- [ ] **Step 3: Implement `log.ts`**

Create `mcp-server/src/tools/diet/log.ts`:

```ts
import type { Pool } from '../../db.js';

export interface LogMealInput {
  uuid: string; date?: string; tz?: string; meal_slot_key?: string;
  name: string; kcal: number;
  protein_g?: number; carb_g?: number; fat_g?: number; saturated_fat_g?: number;
  fiber_g?: number; sugar_g?: number; salt_g?: number; weight_g?: number;
  source: 'label_photo' | 'web_research' | 'estimate';
  photo_ref?: string; notes?: string;
}
export interface LogResult { id: number }

export async function logMeal(pool: Pool, input: LogMealInput): Promise<LogResult> {
  if (!input.uuid) throw new Error('uuid is required');
  if (!input.name || input.kcal == null) throw new Error('adhoc meal requires name and kcal');
  const tz = input.tz ?? 'UTC';

  const existing = await pool.query<{ id: string }>(`SELECT id FROM diet_consumption WHERE uuid=$1`, [input.uuid]);
  if (existing.rows[0]) return { id: Number(existing.rows[0].id) };

  const r = await pool.query<{ id: string }>(
    `INSERT INTO diet_consumption
       (uuid, day, tz, kind, meal_slot_key, name, kcal, protein_g, carb_g, fat_g,
        saturated_fat_g, fiber_g, sugar_g, salt_g, weight_g, source, photo_ref, notes)
     VALUES ($1, COALESCE($2::date, (now() AT TIME ZONE $3)::date), $3, 'adhoc',
             $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [input.uuid, input.date ?? null, tz, input.meal_slot_key ?? null, input.name, input.kcal,
     input.protein_g ?? null, input.carb_g ?? null, input.fat_g ?? null, input.saturated_fat_g ?? null,
     input.fiber_g ?? null, input.sugar_g ?? null, input.salt_g ?? null, input.weight_g ?? null,
     input.source, input.photo_ref ?? null, input.notes ?? null]
  );
  return { id: Number(r.rows[0].id) };
}

export interface LogDeviationInput {
  uuid: string; kind: 'skip' | 'partial' | 'swap';
  day?: string; tz?: string; meal_slot_key?: string; catering_meal_id?: number;
  consumed_fraction?: number; swap_product_id?: number; notes?: string;
}

export async function logDeviation(pool: Pool, input: LogDeviationInput): Promise<LogResult> {
  if (!input.uuid) throw new Error('uuid is required');
  if (!['skip', 'partial', 'swap'].includes(input.kind)) throw new Error(`invalid kind: ${input.kind}`);
  if (input.kind === 'partial' && input.consumed_fraction == null) throw new Error('partial requires consumed_fraction');
  if (input.kind === 'swap' && input.swap_product_id == null) throw new Error('swap requires swap_product_id');
  const tz = input.tz ?? 'UTC';

  const existing = await pool.query<{ id: string }>(`SELECT id FROM diet_consumption WHERE uuid=$1`, [input.uuid]);
  if (existing.rows[0]) return { id: Number(existing.rows[0].id) };

  let mealId = input.catering_meal_id ?? null;
  let day = input.day ?? null;
  if (mealId == null) {
    if (!input.meal_slot_key) throw new Error('either catering_meal_id or (day + meal_slot_key) is required');
    const resolveDay = input.day ?? null;
    const m = await pool.query<{ id: string; day: string }>(
      `SELECT id, to_char(day,'YYYY-MM-DD') AS day FROM diet_catering_meals
        WHERE deleted_at IS NULL AND meal_slot_key = $1
          AND day = COALESCE($2::date, (now() AT TIME ZONE $3)::date)`,
      [input.meal_slot_key, resolveDay, tz]
    );
    if (m.rows.length === 0) throw new Error(`no catering meal for slot ${input.meal_slot_key} on that day`);
    if (m.rows.length > 1) throw new Error(`ambiguous: multiple catering meals for slot ${input.meal_slot_key} that day`);
    mealId = Number(m.rows[0].id);
    day = m.rows[0].day;
  } else {
    const m = await pool.query<{ day: string }>(`SELECT to_char(day,'YYYY-MM-DD') AS day FROM diet_catering_meals WHERE id=$1`, [mealId]);
    if (!m.rows[0]) throw new Error(`catering_meal_id ${mealId} not found`);
    day = m.rows[0].day;
  }

  const r = await pool.query<{ id: string }>(
    `INSERT INTO diet_consumption
       (uuid, day, tz, kind, catering_meal_id, consumed_fraction, swap_product_id, notes)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [input.uuid, day, tz, input.kind, mealId, input.consumed_fraction ?? null,
     input.swap_product_id ?? null, input.notes ?? null]
  );
  return { id: Number(r.rows[0].id) };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd supabase && supabase db reset && cd ../mcp-server && npm test -- src/tools/diet/log.test.ts; cd ..`
Expected: all `logMeal` + `logDeviation` tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/diet/log.ts mcp-server/src/tools/diet/log.test.ts
git commit -m "feat(diet): diet_log_meal + diet_log_deviation"
```

---

## Task 8: `diet_update_entry` + `diet_delete_entry` tools

**Files:**
- Create: `mcp-server/src/tools/diet/edit.ts`
- Test: `mcp-server/src/tools/diet/edit.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/src/tools/diet/edit.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { updateEntry, deleteEntry } from './edit.js';

const writePool = createPool(process.env.MCP_DIET_WRITER_URL ?? 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE diet_consumption RESTART IDENTITY CASCADE');
  await adminPool.query(`INSERT INTO diet_consumption (uuid, day, tz, kind, name, kcal, notes)
    VALUES ('a1', DATE '2026-05-18', 'UTC', 'adhoc', 'Banana', 95, 'first')`);
});

describe('updateEntry', () => {
  it('updates provided fields and preserves omitted ones', async () => {
    await updateEntry(writePool, { uuid: 'a1', kcal: 120 });
    const row = await adminPool.query(`SELECT kcal, name, notes FROM diet_consumption WHERE uuid='a1'`);
    expect(Number(row.rows[0].kcal)).toBe(120);
    expect(row.rows[0].name).toBe('Banana');   // preserved
    expect(row.rows[0].notes).toBe('first');   // preserved
  });

  it('throws when the entry is not found', async () => {
    await expect(updateEntry(writePool, { uuid: 'nope', kcal: 1 })).rejects.toThrow(/not found/);
  });
});

describe('deleteEntry', () => {
  it('soft-deletes (sets deleted_at)', async () => {
    await deleteEntry(writePool, { uuid: 'a1' });
    const row = await adminPool.query(`SELECT deleted_at FROM diet_consumption WHERE uuid='a1'`);
    expect(row.rows[0].deleted_at).not.toBeNull();
  });

  it('throws when the entry is not found', async () => {
    await expect(deleteEntry(writePool, { uuid: 'nope' })).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd mcp-server && npm test -- src/tools/diet/edit.test.ts; cd ..`
Expected: FAIL — cannot resolve `./edit.js`.

- [ ] **Step 3: Implement `edit.ts`**

Create `mcp-server/src/tools/diet/edit.ts`:

```ts
import type { Pool } from '../../db.js';

export interface UpdateEntryInput {
  uuid?: string; id?: number;
  meal_slot_key?: string; consumed_fraction?: number; swap_product_id?: number;
  name?: string; kcal?: number; protein_g?: number; carb_g?: number; fat_g?: number;
  saturated_fat_g?: number; fiber_g?: number; sugar_g?: number; salt_g?: number;
  weight_g?: number; source?: 'label_photo' | 'web_research' | 'estimate';
  photo_ref?: string; notes?: string;
}

function selector(input: { uuid?: string; id?: number }): { clause: string; val: string | number } {
  if (input.uuid) return { clause: 'uuid = $1', val: input.uuid };
  if (input.id != null) return { clause: 'id = $1', val: input.id };
  throw new Error('either uuid or id is required');
}

export async function updateEntry(pool: Pool, input: UpdateEntryInput): Promise<{ id: number }> {
  const sel = selector(input);
  // COALESCE-preserve: omitted (undefined → null param) keeps the prior value.
  const r = await pool.query<{ id: string }>(
    `UPDATE diet_consumption SET
       meal_slot_key     = COALESCE($2, meal_slot_key),
       consumed_fraction = COALESCE($3, consumed_fraction),
       swap_product_id   = COALESCE($4, swap_product_id),
       name              = COALESCE($5, name),
       kcal              = COALESCE($6, kcal),
       protein_g         = COALESCE($7, protein_g),
       carb_g            = COALESCE($8, carb_g),
       fat_g             = COALESCE($9, fat_g),
       saturated_fat_g   = COALESCE($10, saturated_fat_g),
       fiber_g           = COALESCE($11, fiber_g),
       sugar_g           = COALESCE($12, sugar_g),
       salt_g            = COALESCE($13, salt_g),
       weight_g          = COALESCE($14, weight_g),
       source            = COALESCE($15, source),
       photo_ref         = COALESCE($16, photo_ref),
       notes             = COALESCE($17, notes),
       updated_at        = now()
     WHERE ${sel.clause} AND deleted_at IS NULL
     RETURNING id`,
    [sel.val, input.meal_slot_key ?? null, input.consumed_fraction ?? null, input.swap_product_id ?? null,
     input.name ?? null, input.kcal ?? null, input.protein_g ?? null, input.carb_g ?? null,
     input.fat_g ?? null, input.saturated_fat_g ?? null, input.fiber_g ?? null, input.sugar_g ?? null,
     input.salt_g ?? null, input.weight_g ?? null, input.source ?? null, input.photo_ref ?? null,
     input.notes ?? null]
  );
  if (!r.rows[0]) throw new Error('diet_consumption entry not found');
  return { id: Number(r.rows[0].id) };
}

export async function deleteEntry(pool: Pool, input: { uuid?: string; id?: number }): Promise<{ id: number }> {
  const sel = selector(input);
  const r = await pool.query<{ id: string }>(
    `UPDATE diet_consumption SET deleted_at = now(), updated_at = now()
      WHERE ${sel.clause} AND deleted_at IS NULL
      RETURNING id`,
    [sel.val]
  );
  if (!r.rows[0]) throw new Error('diet_consumption entry not found');
  return { id: Number(r.rows[0].id) };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd supabase && supabase db reset && cd ../mcp-server && npm test -- src/tools/diet/edit.test.ts; cd ..`
Expected: all `updateEntry` + `deleteEntry` tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/diet/edit.ts mcp-server/src/tools/diet/edit.test.ts
git commit -m "feat(diet): diet_update_entry + diet_delete_entry"
```

---

## Task 9: `diet_add_note` tool

**Files:**
- Create: `mcp-server/src/tools/diet/notes.ts`
- Test: `mcp-server/src/tools/diet/notes.test.ts`

- [ ] **Step 1: Write the failing test**

Create `mcp-server/src/tools/diet/notes.test.ts`:

```ts
import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { addNote } from './notes.js';

const writePool = createPool(process.env.MCP_DIET_WRITER_URL ?? 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day, diet_products, diet_subscriptions, daily_logs RESTART IDENTITY CASCADE');
  await adminPool.query(`INSERT INTO diet_subscriptions (delivery_diet_id) VALUES (1)`);
  await adminPool.query(`INSERT INTO diet_products (simple_product_id, name) VALUES (10,'B')`);
  await adminPool.query(`INSERT INTO diet_catering_meals
    (delivery_item_id, delivery_diet_id, delivery_id, day, meal_slot_key, meal_slot_position, simple_product_id, status)
    VALUES (100, 1, 9, DATE '2026-05-18', 'BREAKFAST', 1, 10, 'REALIZED')`);
  await adminPool.query(`INSERT INTO diet_consumption (uuid, day, tz, kind, name, kcal)
    VALUES ('e1', DATE '2026-05-18', 'UTC', 'adhoc', 'X', 1)`);
});

describe('addNote', () => {
  it('scope=day appends to daily_logs.notes (insert then append)', async () => {
    await addNote(writePool, { scope: 'day', text: 'line1', day: '2026-05-18', tz: 'UTC' });
    await addNote(writePool, { scope: 'day', text: 'line2', day: '2026-05-18', tz: 'UTC' });
    const row = await adminPool.query(`SELECT notes FROM daily_logs WHERE day = DATE '2026-05-18'`);
    expect(row.rows[0].notes).toBe('line1\nline2');
  });

  it('scope=entry appends to diet_consumption.notes', async () => {
    await addNote(writePool, { scope: 'entry', uuid: 'e1', text: 'first' });
    await addNote(writePool, { scope: 'entry', uuid: 'e1', text: 'second' });
    const row = await adminPool.query(`SELECT notes FROM diet_consumption WHERE uuid='e1'`);
    expect(row.rows[0].notes).toBe('first\nsecond');
  });

  it('scope=meal creates a note row against the catering meal', async () => {
    await addNote(writePool, { scope: 'meal', day: '2026-05-18', meal_slot_key: 'BREAKFAST', text: 'ate as-is, great' });
    const row = await adminPool.query(`SELECT kind, notes, catering_meal_id FROM diet_consumption WHERE kind='note'`);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].notes).toBe('ate as-is, great');
    expect(row.rows[0].catering_meal_id).not.toBeNull();
  });

  it('scope=entry throws when target not found', async () => {
    await expect(addNote(writePool, { scope: 'entry', uuid: 'nope', text: 'x' })).rejects.toThrow(/not found/);
  });
});
```

- [ ] **Step 2: Run the test, expect failure**

Run: `cd mcp-server && npm test -- src/tools/diet/notes.test.ts; cd ..`
Expected: FAIL — cannot resolve `./notes.js`.

- [ ] **Step 3: Implement `notes.ts`**

Create `mcp-server/src/tools/diet/notes.ts`:

```ts
import type { Pool } from '../../db.js';

export interface AddNoteInput {
  scope: 'day' | 'entry' | 'meal';
  text: string;
  day?: string; tz?: string;
  uuid?: string; id?: number;
  catering_meal_id?: number; meal_slot_key?: string;
}

export async function addNote(pool: Pool, input: AddNoteInput): Promise<{ ok: true }> {
  if (!input.text) throw new Error('text is required');
  const tz = input.tz ?? 'UTC';

  if (input.scope === 'day') {
    // Append (not replace — unlike health_log_day). Insert the row if absent.
    await pool.query(
      `INSERT INTO daily_logs (day, tz, notes)
       VALUES (COALESCE($1::date, (now() AT TIME ZONE $2)::date), $2, $3)
       ON CONFLICT (day) DO UPDATE
         SET notes = CASE WHEN daily_logs.notes IS NULL OR daily_logs.notes = ''
                          THEN EXCLUDED.notes
                          ELSE daily_logs.notes || E'\n' || EXCLUDED.notes END,
             updated_at = now()`,
      [input.day ?? null, tz, input.text]
    );
    return { ok: true };
  }

  if (input.scope === 'entry') {
    if (!input.uuid && input.id == null) throw new Error('entry scope requires uuid or id');
    const clause = input.uuid ? 'uuid = $1' : 'id = $1';
    const val: string | number = input.uuid ?? (input.id as number);
    const r = await pool.query(
      `UPDATE diet_consumption
          SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2
                           ELSE notes || E'\n' || $2 END,
              updated_at = now()
        WHERE ${clause} AND deleted_at IS NULL`,
      [val, input.text]
    );
    if ((r.rowCount ?? 0) === 0) throw new Error('diet_consumption entry not found');
    return { ok: true };
  }

  // scope === 'meal' — annotate a planned catering meal (no nutrition effect).
  let mealId = input.catering_meal_id ?? null;
  if (mealId == null) {
    if (!input.meal_slot_key) throw new Error('meal scope requires catering_meal_id or (day + meal_slot_key)');
    const m = await pool.query<{ id: string }>(
      `SELECT id FROM diet_catering_meals
        WHERE deleted_at IS NULL AND meal_slot_key = $1
          AND day = COALESCE($2::date, (now() AT TIME ZONE $3)::date)`,
      [input.meal_slot_key, input.day ?? null, tz]
    );
    if (m.rows.length === 0) throw new Error(`no catering meal for slot ${input.meal_slot_key} on that day`);
    if (m.rows.length > 1) throw new Error(`ambiguous catering meal for slot ${input.meal_slot_key}`);
    mealId = Number(m.rows[0].id);
  }
  await pool.query(
    `INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, meal_slot_key, notes)
     VALUES (gen_random_uuid()::text,
             COALESCE($1::date, (now() AT TIME ZONE $2)::date), $2, 'note', $3, $4, $5)`,
    [input.day ?? null, tz, mealId, input.meal_slot_key ?? null, input.text]
  );
  return { ok: true };
}
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd supabase && supabase db reset && cd ../mcp-server && npm test -- src/tools/diet/notes.test.ts; cd ..`
Expected: all `addNote` tests pass.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/tools/diet/notes.ts mcp-server/src/tools/diet/notes.test.ts
git commit -m "feat(diet): diet_add_note (day/entry/meal scopes)"
```

---

## Task 10: Wire diet tools into the MCP server

**Files:**
- Modify: `mcp-server/src/index.ts`

- [ ] **Step 1: Add the import block**

In `mcp-server/src/index.ts`, after the existing `import { healthLogDay } from './tools/health-log-day.js';` line, add:

```ts
import { syncSubscriptions, syncCateringDay } from './tools/diet/sync.js';
import { logMeal, logDeviation } from './tools/diet/log.js';
import { updateEntry, deleteEntry } from './tools/diet/edit.js';
import { addNote as dietAddNote } from './tools/diet/notes.js';
```

- [ ] **Step 2: Add the `dietWritePool` parameter to `buildMcp`**

Change the `buildMcp` signature and its single call site. Signature:

```ts
function buildMcp(readPool: Pool, writePool: Pool, dietWritePool: Pool): McpServer {
```

Call site (inside the `app.post('/mcp', …)` handler):

```ts
const mcp = buildMcp(readPool, writePool, dietWritePool);
```

- [ ] **Step 3: Register the diet tools**

Immediately before `return server;` at the end of `buildMcp`, add:

```ts
  // --- Diet / nutrition ----------------------------------------------
  server.registerTool('diet_sync_subscriptions',
    { description: 'Upsert diet subscriptions from the raw ntfy.pl /delivery-diets JSON. Idempotent.',
      inputSchema: z.object({ payload: z.unknown() }) },
    async (i) => text(await syncSubscriptions(dietWritePool, (i as { payload: unknown }).payload))
  );
  server.registerTool('diet_sync_catering_day',
    { description: 'Upsert one day of catering (products, meals, day totals) from the raw ntfy.pl /deliveries JSON. Idempotent; never touches consumption.',
      inputSchema: z.object({ payload: z.unknown() }) },
    async (i) => text(await syncCateringDay(dietWritePool, (i as { payload: unknown }).payload))
  );
  server.registerTool('diet_log_meal',
    { description: 'Log an ad-hoc meal with agent-supplied nutrition. Idempotent on uuid.',
      inputSchema: z.object({
        uuid: z.string().min(1), date: z.string().optional(), tz: z.string().optional(),
        meal_slot_key: z.string().optional(), name: z.string().min(1), kcal: z.number(),
        protein_g: z.number().optional(), carb_g: z.number().optional(), fat_g: z.number().optional(),
        saturated_fat_g: z.number().optional(), fiber_g: z.number().optional(),
        sugar_g: z.number().optional(), salt_g: z.number().optional(), weight_g: z.number().optional(),
        source: z.enum(['label_photo','web_research','estimate']),
        photo_ref: z.string().optional(), notes: z.string().optional()
      }) },
    async (i) => text(await logMeal(dietWritePool, i as Parameters<typeof logMeal>[1]))
  );
  server.registerTool('diet_log_deviation',
    { description: 'Record skip/partial/swap against a planned catering meal. Resolves the meal from (day, meal_slot_key) if catering_meal_id is omitted. Idempotent on uuid.',
      inputSchema: z.object({
        uuid: z.string().min(1), kind: z.enum(['skip','partial','swap']),
        day: z.string().optional(), tz: z.string().optional(),
        meal_slot_key: z.string().optional(), catering_meal_id: z.number().int().positive().optional(),
        consumed_fraction: z.number().gt(0).max(1).optional(),
        swap_product_id: z.number().int().positive().optional(), notes: z.string().optional()
      }) },
    async (i) => text(await logDeviation(dietWritePool, i as Parameters<typeof logDeviation>[1]))
  );
  server.registerTool('diet_update_entry',
    { description: 'Edit a diet_consumption row; omitted fields are preserved.',
      inputSchema: z.object({
        uuid: z.string().optional(), id: z.number().int().positive().optional(),
        meal_slot_key: z.string().optional(), consumed_fraction: z.number().gt(0).max(1).optional(),
        swap_product_id: z.number().int().positive().optional(), name: z.string().optional(),
        kcal: z.number().optional(), protein_g: z.number().optional(), carb_g: z.number().optional(),
        fat_g: z.number().optional(), saturated_fat_g: z.number().optional(),
        fiber_g: z.number().optional(), sugar_g: z.number().optional(), salt_g: z.number().optional(),
        weight_g: z.number().optional(), source: z.enum(['label_photo','web_research','estimate']).optional(),
        photo_ref: z.string().optional(), notes: z.string().optional()
      }) },
    async (i) => text(await updateEntry(dietWritePool, i as Parameters<typeof updateEntry>[1]))
  );
  server.registerTool('diet_delete_entry',
    { description: 'Soft-delete a diet_consumption row (sets deleted_at). Catering data is not tool-deletable.',
      inputSchema: z.object({ uuid: z.string().optional(), id: z.number().int().positive().optional() }) },
    async (i) => text(await deleteEntry(dietWritePool, i as { uuid?: string; id?: number }))
  );
  server.registerTool('diet_add_note',
    { description: "Append a note. scope='day' → daily_logs; 'entry' → a diet_consumption row; 'meal' → a note against a planned catering meal.",
      inputSchema: z.object({
        scope: z.enum(['day','entry','meal']), text: z.string().min(1),
        day: z.string().optional(), tz: z.string().optional(),
        uuid: z.string().optional(), id: z.number().int().positive().optional(),
        catering_meal_id: z.number().int().positive().optional(), meal_slot_key: z.string().optional()
      }) },
    async (i) => { await dietAddNote(dietWritePool, i as Parameters<typeof dietAddNote>[1]); return text({ ok: true }); }
  );
```

- [ ] **Step 4: Create the `dietWritePool` in `startServer`**

In `startServer`, after the `writeDsn` checks and `writePool` creation, add:

```ts
  const dietDsn = process.env.MCP_DIET_WRITER_URL;
  if (!dietDsn) throw new Error('MCP_DIET_WRITER_URL is not set');
  const dietWritePool = createPool(dietDsn);
```

Update the `buildMcp(readPool, writePool)` call inside the POST handler to `buildMcp(readPool, writePool, dietWritePool)`. In the `close` callback, after `await writePool.end();` add `await dietWritePool.end();`.

- [ ] **Step 5: Typecheck and run the full server test suite**

Run: `cd supabase && supabase db reset && cd ../mcp-server && npm run typecheck && npm test; cd ..`
Expected: typecheck clean; all tests pass (existing health/gym tests + the four new diet test files). The existing `index.test.ts` sets `MCP_DIET_WRITER_URL`? If `index.test.ts` calls `startServer` and now fails on the new required env var, set it: in `mcp-server/src/index.test.ts`, wherever `MCP_GYM_WRITER_URL` is assigned for the test, add the same for `MCP_DIET_WRITER_URL` pointing at `postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres`. (Inspect `index.test.ts` first; mirror exactly how it sets `MCP_GYM_WRITER_URL`.)

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/index.ts mcp-server/src/index.test.ts
git commit -m "feat(diet): register diet tools + dietWritePool wiring"
```

---

## Task 11: Extend the `schema://tables` resource

**Files:**
- Modify: `mcp-server/src/resources/schema.ts`
- Modify: `mcp-server/src/resources/schema.test.ts`

- [ ] **Step 1: Add the failing resource assertions**

Inspect `mcp-server/src/resources/schema.test.ts` to see how it calls `describeSchema` and asserts content. Add assertions in the same style as the existing ones:

```ts
it('documents the diet domain', async () => {
  const md = await describeSchema(readPool);
  expect(md).toContain('diet_catering_meals');
  expect(md).toContain('diet_consumed_day(tz)');
  expect(md).toContain('diet_energy_balance(tz)');
  expect(md).toContain("'VEGAN' = ANY (p.categories)");
});
```

(Match the existing test's `describeSchema` invocation and pool variable name exactly.)

- [ ] **Step 2: Run the test, expect failure**

Run: `cd mcp-server && npm test -- src/resources/schema.test.ts; cd ..`
Expected: FAIL — the new `it('documents the diet domain')` fails (strings absent).

- [ ] **Step 3: Extend `describeSchema`**

In `mcp-server/src/resources/schema.ts`:

1. Add the five diet tables to the `table_name IN (…)` list in the `information_schema.columns` query:
   `'diet_subscriptions','diet_products','diet_catering_meals','diet_catering_day','diet_consumption'`.

2. In the "Set-returning functions" bullet list, append:

```
'- `diet_consumed_day(tz)` — per-day planned vs effective-consumed nutrition (catering minus skips, ×fraction for partials, swap-product for swaps, plus ad-hoc; `note`/deleted excluded) with deviation counts.',
'- `diet_weekly(tz)` — weekly buckets of the above.',
'- `diet_energy_balance(tz)` — per-day `intake_kcal` vs HealthKit active+basal energy; `net_kcal`.',
```

3. Append a new prose + examples section to the returned markdown array (before the final `].join('\n')`), reproducing the spec's "Resource update" example queries verbatim:

```
'',
'## Diet / nutrition',
'',
'`diet_catering_meals`/`diet_catering_day`/`diet_products`/`diet_subscriptions` are an idempotent mirror of the ntfy.pl catering plan — mutated only via the `diet_sync_*` tools. `diet_consumption` is the sparse, user-owned log of deviations (`skip`/`partial`/`swap`), ad-hoc meals (`adhoc`), and annotations (`note`); `note` and soft-deleted rows are excluded from all nutrition math. `run_sql` is read-only on `diet_*` — mutate via the `diet_*` tools.',
'',
'```sql',
"-- yesterday: consumed vs plan target",
"SELECT day, plan_target_kcal, consumed_kcal, consumed_protein_g,",
"       n_skip, n_partial, n_swap, n_adhoc",
"  FROM diet_consumed_day('Europe/Warsaw')",
" WHERE day = current_date - 1;",
'',
"-- weekly energy balance",
"SELECT day, intake_kcal, total_out_kcal, net_kcal",
"  FROM diet_energy_balance('Europe/Warsaw')",
" WHERE day >= current_date - INTERVAL '7 days' ORDER BY day;",
'',
"-- vegan catering days in the last 30",
"SELECT m.day, count(*) AS vegan_meals",
"  FROM diet_catering_meals m",
"  JOIN diet_products p ON p.simple_product_id = m.simple_product_id",
" WHERE m.deleted_at IS NULL AND 'VEGAN' = ANY (p.categories)",
"   AND m.day >= current_date - 30",
" GROUP BY m.day ORDER BY m.day DESC;",
'',
"-- cross-domain: protein intake vs training volume that day",
"SELECT d.day, d.consumed_protein_g,",
"       COALESCE(SUM(ts.weight_kg * ts.reps), 0) AS gym_volume_kg",
"  FROM diet_consumed_day('Europe/Warsaw') d",
"  LEFT JOIN training_sessions s",
"    ON s.deleted_at IS NULL",
"   AND (s.started_at AT TIME ZONE 'Europe/Warsaw')::date = d.day",
"  LEFT JOIN training_exercises te ON te.session_id = s.id AND te.deleted_at IS NULL",
"  LEFT JOIN training_sets ts ON ts.training_exercise_id = te.id AND ts.deleted_at IS NULL",
" WHERE d.day >= current_date - 14",
" GROUP BY d.day, d.consumed_protein_g ORDER BY d.day DESC;",
'```'
```

- [ ] **Step 4: Run the test, expect pass**

Run: `cd supabase && supabase db reset && cd ../mcp-server && npm test -- src/resources/schema.test.ts; cd ..`
Expected: the diet-domain test passes alongside the existing schema tests.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/resources/schema.ts mcp-server/src/resources/schema.test.ts
git commit -m "feat(diet): document diet domain in schema://tables"
```

---

## Task 12: `diet-coach` skill

**Files:**
- Create: `skill_example/diet-coach/SKILL.md`

- [ ] **Step 1: Write the skill**

Create `skill_example/diet-coach/SKILL.md`. Use `skill_example/gym-coach/SKILL.md` as the structural template (frontmatter, Role, MCP surface table, Playbooks, Behavior, Anti-patterns, Coexistence). Content must implement the spec's "`diet-coach` skill" section exactly, including:

```markdown
---
name: diet-coach
description: Use when syncing the ntfy.pl catering plan, logging meal deviations (skip/partial/swap), logging ad-hoc meals from a photo (nutrition label or web-researched), capturing diet notes, or analyzing nutrition vs activity/gym via run_sql.
---

# Diet Coach

## Role

You are a nutrition-tracking partner with write access to the user's diet log via the `oc-health-sync` MCP server. Capture what was actually eaten relative to the catering plan and return grounded numbers. The user's goals live with you, not the MCP — it stores and aggregates; you judge. Never prescribe diets or make medical claims.

## MCP surface

| Tool | Purpose | Inputs |
|---|---|---|
| `diet_sync_subscriptions` | Mirror the subscription list | `payload` (raw /delivery-diets JSON) |
| `diet_sync_catering_day` | Mirror one day's plan | `payload` (raw /deliveries JSON) |
| `diet_log_meal` | Ad-hoc meal, agent-supplied nutrition | `uuid`, `name`, `kcal`, macros?, `source`, `date?`, `meal_slot_key?`, `photo_ref?`, `notes?` |
| `diet_log_deviation` | skip / partial / swap a planned meal | `uuid`, `kind`, `day?`+`meal_slot_key?` **or** `catering_meal_id`, `consumed_fraction?`, `swap_product_id?` |
| `diet_update_entry` | Edit a logged entry | `uuid`\|`id` + fields |
| `diet_delete_entry` | Soft-delete a logged entry | `uuid`\|`id` |
| `diet_add_note` | Note at day/entry/meal scope | `scope`, `text`, target |
| `run_sql` | Custom + cross-domain analysis | a single read-only SQL statement |

Resource `schema://tables` documents `diet_consumed_day(tz)`, `diet_weekly(tz)`, `diet_energy_balance(tz)`, the tables, and example queries. Read it before your first `run_sql` in a session.

## Playbooks

### Catering sync (cron)
1. `diet_sync_subscriptions` with the raw `/delivery-diets` JSON.
2. For today and any un-synced recent delivery day, `diet_sync_catering_day` with that day's `/deliveries` JSON. Skip non-delivery days (the subscription's `delivery_days`). One-line confirm.

### Prev-day recap (cron)
`run_sql` `diet_consumed_day` + `diet_energy_balance` for yesterday. Lead with consumed kcal vs `plan_target_kcal` and `net_kcal`; one line on deviations. You know the user's goals — interpret, don't dump.

### Photo — nutrition label visible
Read the label with vision → confirm the eaten portion/grams with the user → `diet_log_meal(source='label_photo')`.

### Photo — product, no label
Identify the product with vision → **web search** its nutrition (per 100 g / per portion) → show the user the values **and the source** → clarify grams/portion eaten → `diet_log_meal(source='web_research')`. When you are genuinely guessing, use `source='estimate'` and say so.

### Deviation
"Ate half my lunch" → `diet_log_deviation(kind='partial', day=today, meal_slot_key='LUNCH', consumed_fraction=0.5)`. `skip` and `swap` analogously; for `swap`, resolve the alternative product id (it is already in `diet_products`, usually within the meal's `alternative_product_ids`).

### Notes
Day-level → `diet_add_note(scope='day')`. About a logged entry → `scope='entry'`. About a planned meal you ate as-is → `scope='meal'`.

### Analysis
Custom and cross-domain (diet × gym × health) via `run_sql`. Read `schema://tables` first.

## Behavior

- Grams and kcal are canonical. Always **confirm the portion before logging**.
- One-line confirmations. Lead with the number vs the plan target.
- Flag estimated nutrition (`source`).
- Generate a fresh `uuid` per log call; reuse the same one on retry.

## Anti-patterns

- No logging without portion confirmation.
- No invented nutrition — a label or a cited web source only.
- No `run_sql` when a typed tool fits.
- No moralizing about food choices. No diagnosing.

## Coexistence with `health-coach` / `gym-coach`

All three can be active. Cross-domain questions ("did yesterday's deficit hurt today's lift?") are `run_sql` territory — `schema://tables` shows an example.
```

- [ ] **Step 2: Sanity-check the frontmatter**

Run: `head -4 skill_example/diet-coach/SKILL.md`
Expected: a valid YAML frontmatter block with `name: diet-coach` and a `description:` line (mirrors `gym-coach`).

- [ ] **Step 3: Commit**

```bash
git add skill_example/diet-coach/SKILL.md
git commit -m "feat(diet): diet-coach skill"
```

---

## Task 13: Deploy wiring (`MCP_DIET_WRITER_URL`)

**Files:**
- Modify: `deploy/install.sh`
- Modify: `deploy/docker-compose.mcp.yml`
- Modify: `deploy/.env.example`
- Modify: `deploy/README.md`
- Modify: `README.md`

- [ ] **Step 1: `deploy/.env.example`**

After the `MCP_DATABASE_URL=…` line add:

```
MCP_GYM_WRITER_URL=postgresql://gym_writer_user:changeme-gym-pw@db:5432/postgres
MCP_DIET_WRITER_URL=postgresql://diet_writer_user:changeme-diet-pw@db:5432/postgres
```

(`MCP_GYM_WRITER_URL` is currently missing from this reference file — add both so the reference is complete.)

- [ ] **Step 2: `deploy/docker-compose.mcp.yml` (tracked copy)**

In the `mcp:` service `environment:` block, after `MCP_GYM_WRITER_URL: ${MCP_GYM_WRITER_URL}` add:

```yaml
      MCP_DIET_WRITER_URL: ${MCP_DIET_WRITER_URL}
```

- [ ] **Step 3: `deploy/install.sh` — first-install env generation**

In the `if [[ "$MODE" == "install" && ! -f .env ]]` block: after the `GYM_WRITER_PASSWORD="${GYM_WRITER_PASSWORD:-$(randhex 16)}"` line add:

```bash
  DIET_WRITER_PASSWORD="${DIET_WRITER_PASSWORD:-$(randhex 16)}"
```

In the generated `.env` heredoc, after the `GYM_WRITER_PASSWORD=$GYM_WRITER_PASSWORD` and `MCP_GYM_WRITER_URL=…` lines add:

```
DIET_WRITER_PASSWORD=$DIET_WRITER_PASSWORD
MCP_DIET_WRITER_URL=postgresql://diet_writer_user:$DIET_WRITER_PASSWORD@db:5432/postgres
```

- [ ] **Step 4: `deploy/install.sh` — upgrade backfill**

In the `if [[ "$MODE" == "upgrade" && -f .env ]]` block, after the existing gym backfill lines add:

```bash
  # v0.4.0 — diet writer credentials.
  if ! grep -q '^DIET_WRITER_PASSWORD=' .env; then
    append_env "DIET_WRITER_PASSWORD" "$(randhex 16)"
  fi
  _diet_writer_pw="$(grep '^DIET_WRITER_PASSWORD=' .env | head -1 | cut -d= -f2-)"
  append_env "MCP_DIET_WRITER_URL" "postgresql://diet_writer_user:${_diet_writer_pw}@db:5432/postgres"
  unset _diet_writer_pw
```

- [ ] **Step 5: `deploy/install.sh` — compose overlay heredoc + provisioning psql**

In the `cat > docker-compose.mcp.yml <<'YAML'` heredoc, after `MCP_GYM_WRITER_URL: ${MCP_GYM_WRITER_URL}` add `MCP_DIET_WRITER_URL: ${MCP_DIET_WRITER_URL}`.

In the provisioning psql heredoc, after the `gym_writer_user` `IF NOT EXISTS … CREATE/ALTER` fork add:

```sql
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diet_writer_user') THEN
    CREATE ROLE diet_writer_user LOGIN PASSWORD '${DIET_WRITER_PASSWORD}' IN ROLE diet_writer_role;
  ELSE
    ALTER ROLE diet_writer_user WITH PASSWORD '${DIET_WRITER_PASSWORD}';
  END IF;
```

and after `GRANT gym_writer_role TO gym_writer_user;` add `GRANT diet_writer_role TO diet_writer_user;`. Also update the echo line to mention `diet_writer_user`.

- [ ] **Step 6: `deploy/README.md` + `README.md`**

In `deploy/README.md`, wherever `MCP_GYM_WRITER_URL` / `gym_writer_user` are documented, add the parallel `MCP_DIET_WRITER_URL` / `diet_writer_user` entry (one line each, same wording pattern).

In top-level `README.md`, in the "MCP client identity prompt" section after the gym-coach paragraph, add: a one-sentence note that a third `diet-coach` skill/persona uses the `diet_*` tools (see `skill_example/diet-coach/SKILL.md`), routed by intent like the others.

- [ ] **Step 7: Lint the shell script**

Run: `bash -n deploy/install.sh`
Expected: no output, exit 0 (syntax valid).

- [ ] **Step 8: Commit**

```bash
git add deploy/install.sh deploy/docker-compose.mcp.yml deploy/.env.example deploy/README.md README.md
git commit -m "feat(diet): deploy wiring for MCP_DIET_WRITER_URL + diet_writer_user"
```

---

## Task 14: Full verification + PII cleanup

**Files:**
- Delete: `ntfy-deliveries-2026-05-18.json`, `ntfy-delivery-diets.json` (repo-root raw captures)

- [ ] **Step 1: Delete the raw PII captures**

Run: `rm -f ntfy-deliveries-2026-05-18.json ntfy-delivery-diets.json && git status --porcelain`
Expected: the two files are gone; `git status` shows nothing about them (they were gitignored — never tracked). The sanitized fixtures under `mcp-server/test/fixtures/` remain.

- [ ] **Step 2: Full DB + server suite**

Run:
```bash
cd supabase && supabase db reset && \
for t in tests/*.test.sql; do psql 'postgresql://postgres:postgres@127.0.0.1:54422/postgres' -f "$t" || exit 1; done && \
cd ../mcp-server && npm run typecheck && npm test && cd ..
```
Expected: every psql test prints its `… OK`; typecheck clean; full vitest suite green (health + gym + diet).

- [ ] **Step 3: Edge-function tests (regression guard)**

Run: `cd supabase/functions/ingest && deno test --allow-env --allow-net --allow-read; cd ../../..`
Expected: unchanged — still passing (diet work does not touch the ingest function).

- [ ] **Step 4: Final review against the spec**

Re-read `docs/superpowers/specs/2026-05-17-diet-tracker-design.md` "Definition"/Goals and confirm each goal maps to a committed task. Confirm no `ntfy-*.json` PII is tracked: `git ls-files | grep -i ntfy` → only `mcp-server/test/fixtures/ntfy-*.json` (sanitized) appears.

- [ ] **Step 5: Commit any final docs and finish the branch**

```bash
git status --porcelain
```
If clean, the feature is complete. Use `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review

**1. Spec coverage:**

| Spec requirement | Task |
|---|---|
| 5 tables + indexes | Task 1 |
| `diet_writer_role` + cross-domain isolation | Task 2 |
| `diet_consumed_day` / `diet_weekly` / `diet_energy_balance` | Task 3 |
| Local-dev login user | Task 4 |
| Sanitized fixtures; raw PII deleted | Task 5, Task 14 |
| `diet_sync_subscriptions` / `diet_sync_catering_day` (crc32 gate, no-delivery no-op, missing-product stub + warnings) | Task 6 |
| `diet_log_meal` / `diet_log_deviation` (resolve slot, kind validation, idempotent) | Task 7 |
| `diet_update_entry` (COALESCE preserve) / `diet_delete_entry` (soft-delete) | Task 8 |
| `diet_add_note` (day reuses daily_logs append; entry; meal `kind='note'`) | Task 9 |
| `dietWritePool` + tool registration + `MCP_DIET_WRITER_URL` guard | Task 10 |
| `schema://tables` extended (tables, functions, examples) | Task 11 |
| `diet-coach` skill incl. label-photo + web-research playbooks | Task 12 |
| Deploy wiring (install.sh, compose, .env.example, READMEs) | Task 13 |
| Full test conventions (psql loop + vitest + deno) | Tasks 1–3, 14 |

No spec requirement is without a task.

**2. Placeholder scan:** Every code/SQL/test step contains complete, runnable content. The only "copy verbatim from spec" directives (Task 1 DDL, Task 2 grants) point at the committed spec whose DDL is itself complete and exact — reproduced rather than re-typed to avoid divergence between two documents; the spec section is the single source of truth and is quoted in full there.

**3. Type consistency:** Tool function names and signatures are consistent across tasks and the `index.ts` wiring: `syncSubscriptions`/`syncCateringDay` (Task 6 → Task 10), `logMeal`/`logDeviation` (Task 7 → Task 10), `updateEntry`/`deleteEntry` (Task 8 → Task 10), `addNote` imported as `dietAddNote` (Task 9 → Task 10). Result shapes (`{ id }`, `{ ok: true }`, `{ products, meals, day, no_delivery, warnings }`, `{ upserted }`) match between implementation and tests. SQL function column names match between Task 3's `RETURNS TABLE` and the assertions in Task 3's test and the resource examples in Task 11.

Plan is internally consistent and fully covers the spec.
