# oc-health-sync — Diet / Nutrition Tracker

**Date:** 2026-05-17
**Status:** Approved (brainstorming complete, awaiting implementation plan)
**Author:** Dominik Barcikowski (with Claude)

## Context

`oc-health-sync` today has two domains in one Supabase + MCP server over Tailscale: **health** (Apple HealthKit, ingested by the iOS app → Edge Function) and **gym** (training sessions/exercises/sets, written via MCP `gym_*` tools). Reads are via `run_sql` + a `schema://tables` resource; analysis lives in client-side skills (`health-coach`, `gym-coach`).

This design adds a third domain, **diet/nutrition**, alongside the others — same repo, same Postgres, same MCP server. It tracks meals from a catering provider (Nice To Fit You, `ntfy.pl`), ad-hoc meals logged from photos, and deviations from the plan. Co-location enables cross-domain SQL (intake × HealthKit energy, protein × training load) via plain joins.

The user's agent platform ("Hermes", an MCP client) holds a persisted `ntfy.pl` browser session and can run cron routines. The catering fetch stays in Hermes; the MCP server is a pure data plane.

### Provider API (reverse-engineered 2026-05-17)

Host `orion-api.ntfy.pl/api/v2.0`. Auth = the logged-in browser session (cookies); `user_id` is in the URL path. Two endpoints matter:

- `GET /users/{user_id}/delivery-diets?...` → subscription list. Each: `id` (the `delivery_diet_id`), `diet_id`, `user_diet_name`, `kcal` (plan target), `first_delivery_day`, `last_delivery_day`, `delivery_days[]`, `status`.
- `GET /users/{user_id}/deliveries?expansions__in=…&aggregate_by__in=nutritional_data:date&date=YYYY-MM-DD&delivery_diet_id={id}&status__in=TO-BE-REALIZED,REALIZED` → one day's delivery.

Envelope: `{ data: { results, includes, aggregates, result_count }, … }`.

- `results[0]` — the delivery (`id`, `date`, `status`, `address_id`, prices, cutoffs).
- `includes.delivery_items[]` (5) — one per meal slot: `id` (`delivery_item_id`), `delivery_id`, `diet_variant_meal_id`, `simple_product_id`, `status`, `rating_value`, `rating_comment`, `is_simple_product_selected_by_user`.
- `includes.diet_variant_meals[]` — slot definitions: `id`, `diet_variant_meal_type_id`, `kcal` (slot target). `nutritional_values` is mostly null — real nutrition is on the product.
- `includes.diet_variant_meal_types[]` — the 5 slots: keys `BREAKFAST`, `SECOND-BREAKFAST`, `LUNCH`, `TEA`, `DINNER`; Polish `meal_name.value`; `position` 1–5.
- `includes.simple_products[]` (~45, selected + alternatives) — the food, full per-portion nutrition: `id`, `name`, `composition`, `weight` (g), `kind`, `calorific` (kcal), `kj`, `protein`, `carb`, `fat`, `saturated_fat`, `fiber`, `sugar`, `salt`, `*_percent`, `allergens[]`, `categories[]` (e.g. `VEGAN`, `VEGETARIAN`, `DAIRY-FREE`), `images[]`, `crc32` (content hash).
- `includes.alternative_meals[]` — per `delivery_item_id`, `simple_product_ids[]` the user could swap to.
- `aggregates[]` — `nutritional_data:date` rollup: `calorific_kcal`, `calorific_kj`, `protein`, `carb`, `fat`, `fiber`, `saturated_fat`, `sugar`, `salt`, `protein_percent`, `carb_percent`, `fat_percent`, and `calorific_kcal_offer` (the day's plan target).

Not every calendar day has a delivery (weekends/skips — see `delivery_days[]`); such a day returns `result_count: 0`.

Sample captures (gitignored, contain PII): `ntfy-deliveries-2026-05-18.json`, `ntfy-delivery-diets.json`.

## Goals

1. Idempotently mirror the daily catering plan (subscription, products, per-slot meals, provider day totals) into Postgres via an MCP tool that takes the raw provider JSON. Safe to re-run and back-fill.
2. Default assumption: synced catering meals were eaten 100%. Only **deviations** are logged — skip, partial portion, swap to an alternative.
3. Log ad-hoc meals from a photo: the agent (vision/web) supplies structured nutrition; the MCP only stores numbers. Provenance recorded (`label_photo` / `web_research` / `estimate`).
4. Edit and soft-delete logged consumption entries via tools.
5. Free-text notes at day / meal / entry scope.
6. Return clean per-day and weekly aggregates, and a per-day **energy balance** (intake vs HealthKit active+basal energy) as set-returning SQL functions for `run_sql`.
7. Document everything in `schema://tables` and ship a `diet-coach` skill that drives the flows (catering sync, photo logging with web research, deviations, notes, analysis).

## Non-goals

- No image processing in the MCP. The agent does vision/web research; the MCP stores numbers.
- No goal/target/adherence scoring in the MCP. It returns data, summaries, averages; the agent knows the user's goals and judges.
- No baked-markdown summary tool (no `diet_summary`). Recaps are composed by the skill from `run_sql` over the SQL functions — consistent with the user's "MCP returns data, Hermes analyzes" principle.
- No multi-provider abstraction. `ntfy.pl` only. A `raw JSONB` shadow per provider row eases a future second provider.
- No Hermes session-persistence or cron implementation. This spec defines the MCP contract only; the fetch/cron is Hermes-side.
- No tool-based editing or deleting of catering data. Re-sync owns it; corrections via a privileged `run_sql`.
- iOS app changes. HealthKit-only stays.
- Multi-user / tenancy. Single-user, no `user_id` columns (matches `health_samples`/gym).
- Public exposure. Tailnet-only, unchanged.

## Decisions

| | Decision | Rationale |
|---|---|---|
| Housing | Third domain in the same repo/DB/MCP server | Shared infra; cross-domain SQL joins with `health_samples` and gym tables. |
| Sync contract | Hermes fetches; a `diet_sync_*` tool takes the **raw provider JSON**; the MCP parses + upserts | Parsing is deterministic, versioned, unit-tested in TypeScript — not fragile agent prose. Matches the "typed tool owns the DB work" pattern. Credentials/session stay in Hermes. |
| Consumption model | Catering meals assumed eaten 100%; only deviations (`skip`/`partial`/`swap`) and ad-hoc meals are rows | Minimal daily friction; sparse table. |
| Plan vs edits separation | Immutable provider mirror tables + a separate user-owned `diet_consumption` | Re-sync / back-fill never clobbers a logged deviation. |
| Targets | None stored. The provider's own plan target (`calorific_kcal_offer`) is mirrored as a **fact**; no scoring | The agent owns goals; MCP owns data. |
| Nutrient storage | One typed `NUMERIC` column per nutrient; `JSONB` only as a forward-compat shadow, never the query surface | Queryable; no JSON extraction in analysis. |
| Product catalog | `diet_products` keyed by provider `simple_product_id`, `crc32`-gated updates | Mirrors the `exercises` catalog; swaps and alternatives resolve to known nutrition. |
| Idempotency | Provider ids (`delivery_diet_id`, `simple_product_id`, `delivery_item_id`, `(delivery_diet_id, day)`) for catering; client `uuid` for `diet_consumption` | Same retry-safe stance as `health_samples.uuid` / gym. |
| Provider day totals | Stored verbatim in `diet_catering_day` | Provider value is canonical; avoids recompute/rounding drift. |
| Notes | `scope='day'` reuses `daily_logs.notes`; `scope='entry'`/`'meal'` on `diet_consumption` (`kind='note'`) | No new notes table. |
| Reads | `run_sql` + 3 SQL functions + `schema://tables` + `diet-coach` skill; no read tools | Same pattern as `health-coach`/`gym-coach`. |
| Roles | Dedicated `diet_writer_role` (NOLOGIN, migration) + `diet_writer_user` (LOGIN, seed) + new `MCP_DIET_WRITER_URL` + third `dietWritePool`; cross-domain `REVOKE` both ways | True privilege isolation per the user's explicit preference over reusing `gym_writer_role`. |
| Soft-delete | `deleted_at` on `diet_consumption` (and shadowable on others); catering not tool-deletable | Repo convention. |
| Migration discipline | Additive, idempotent, nullable defaults; old MCP image keeps working | `CONTRIBUTING.md`. |

## Architecture

```
┌─────────────────────────────┐        ┌──────────────────────────────────────────┐
│ Hermes (MCP client)         │        │ Tailnet-only MCP server (Node 24)          │
│  + diet-coach skill         │        │  ┌ readPool (health_read_role) ───────────┐│
│  + persisted ntfy.pl session│        │  │  run_sql, schema://tables              ││
│                             │        │  └────────────────────────────────────────┘│
│  6am cron routine ──fetch──▶ orion-api│  ┌ dietWritePool (diet_writer_role) ───────┐│
│   raw JSON ─────────────────┼──HTTP──▶│  │  diet_sync_subscriptions               ││
│  photo / chat ──────────────┼──HTTP──▶│  │  diet_sync_catering_day                ││
│                             │        │  │  diet_log_meal / diet_log_deviation     ││
│  prev-day recap (cron) ─────┼──HTTP──▶│  │  diet_update_entry / diet_delete_entry  ││
│   run_sql                   │        │  │  diet_add_note                          ││
└─────────────────────────────┘        │  └────────────────────────────────────────┘│
                                        │  Postgres: diet_* + health_samples + gym_* │
                                        └──────────────────────────────────────────┘
```

Three write paths: (1) 6am catering sync — Hermes fetches the authenticated JSON and forwards it to `diet_sync_subscriptions` + `diet_sync_catering_day`; (2) ad-hoc meal — the agent estimates nutrition (vision/web) and calls `diet_log_meal`; (3) deviation — `diet_log_deviation`. Reads: the agent uses `run_sql` over `diet_consumed_day` / `diet_weekly` / `diet_energy_balance` + `schema://tables`. The 6am cron and the prev-day recap are Hermes routines, not MCP cron.

## Database schema

Migration `supabase/migrations/20260517000000_init_diet_tables.sql`. Idempotent (`CREATE … IF NOT EXISTS`). Shared nutrient columns (all `NUMERIC`, nullable): `kcal, kj, protein_g, carb_g, fat_g, saturated_fat_g, fiber_g, sugar_g, salt_g, protein_pct, carb_pct, fat_pct`.

### Tables

**`diet_subscriptions`** — provider mirror.

```sql
CREATE TABLE IF NOT EXISTS diet_subscriptions (
  delivery_diet_id   BIGINT PRIMARY KEY,
  diet_id            BIGINT,
  user_diet_name     TEXT,
  plan_kcal          INT,
  first_delivery_day DATE,
  last_delivery_day  DATE,
  status             TEXT,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
```

**`diet_products`** — product catalog (like `exercises`).

```sql
CREATE TABLE IF NOT EXISTS diet_products (
  simple_product_id  BIGINT PRIMARY KEY,
  name               TEXT NOT NULL,
  composition        TEXT,
  weight_g           NUMERIC,
  kind               TEXT,
  kcal NUMERIC, kj NUMERIC,
  protein_g NUMERIC, carb_g NUMERIC, fat_g NUMERIC,
  saturated_fat_g NUMERIC, fiber_g NUMERIC, sugar_g NUMERIC, salt_g NUMERIC,
  protein_pct NUMERIC, carb_pct NUMERIC, fat_pct NUMERIC,
  categories         TEXT[] NOT NULL DEFAULT '{}',
  allergens          TEXT[] NOT NULL DEFAULT '{}',
  images             JSONB,
  crc32              TEXT,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ
);
```

`categories`/`allergens` store the provider tag `key`s (e.g. `VEGAN`). Upsert by PK; if the incoming `crc32` equals the stored one, skip the write (no-op, `updated_at` unchanged).

**`diet_catering_meals`** — immutable synced plan, one row per delivery slot.

```sql
CREATE TABLE IF NOT EXISTS diet_catering_meals (
  id                     BIGSERIAL PRIMARY KEY,
  delivery_item_id       BIGINT NOT NULL UNIQUE,
  delivery_diet_id       BIGINT NOT NULL REFERENCES diet_subscriptions(delivery_diet_id),
  delivery_id            BIGINT NOT NULL,
  day                    DATE NOT NULL,
  diet_variant_meal_id   BIGINT,
  meal_slot_key          TEXT,
  meal_slot_name         TEXT,
  meal_slot_position     SMALLINT,
  simple_product_id      BIGINT REFERENCES diet_products(simple_product_id),
  slot_kcal_target       INT,
  status                 TEXT,
  alternative_product_ids BIGINT[] NOT NULL DEFAULT '{}',
  raw                    JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ
);
```

Upsert by `delivery_item_id`. Pure provider mirror — safe to overwrite (user edits live elsewhere).

**`diet_catering_day`** — provider's authoritative day rollup.

```sql
CREATE TABLE IF NOT EXISTS diet_catering_day (
  delivery_diet_id   BIGINT NOT NULL REFERENCES diet_subscriptions(delivery_diet_id),
  day                DATE NOT NULL,
  plan_kcal          INT,           -- calorific_kcal_offer
  kcal NUMERIC, kj NUMERIC,
  protein_g NUMERIC, carb_g NUMERIC, fat_g NUMERIC,
  saturated_fat_g NUMERIC, fiber_g NUMERIC, sugar_g NUMERIC, salt_g NUMERIC,
  protein_pct NUMERIC, carb_pct NUMERIC, fat_pct NUMERIC,
  raw                JSONB,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (delivery_diet_id, day)
);
```

**`diet_consumption`** — sparse, user-owned, mutable, soft-delete.

```sql
CREATE TABLE IF NOT EXISTS diet_consumption (
  id                BIGSERIAL PRIMARY KEY,
  uuid              TEXT NOT NULL UNIQUE,
  day               DATE NOT NULL,           -- local date in tz
  tz                TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('skip','partial','swap','adhoc','note')),
  catering_meal_id  BIGINT REFERENCES diet_catering_meals(id),
  meal_slot_key     TEXT,
  consumed_fraction NUMERIC CHECK (consumed_fraction > 0 AND consumed_fraction <= 1),
  swap_product_id   BIGINT REFERENCES diet_products(simple_product_id),
  name              TEXT,
  kcal NUMERIC, protein_g NUMERIC, carb_g NUMERIC, fat_g NUMERIC,
  saturated_fat_g NUMERIC, fiber_g NUMERIC, sugar_g NUMERIC, salt_g NUMERIC,
  weight_g          NUMERIC,
  source            TEXT CHECK (source IN ('label_photo','web_research','estimate')),
  photo_ref         TEXT,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT diet_consumption_kind_fields CHECK (
    (kind = 'skip'    AND catering_meal_id IS NOT NULL)
 OR (kind = 'partial' AND catering_meal_id IS NOT NULL AND consumed_fraction IS NOT NULL)
 OR (kind = 'swap'    AND catering_meal_id IS NOT NULL AND swap_product_id IS NOT NULL)
 OR (kind = 'adhoc'   AND name IS NOT NULL AND kcal IS NOT NULL)
 OR (kind = 'note'    AND notes IS NOT NULL
                       AND (catering_meal_id IS NOT NULL OR meal_slot_key IS NOT NULL))
  )
);
```

`note` rows are annotations only and are excluded from all nutrition math.

### Indexes

```sql
CREATE INDEX IF NOT EXISTS idx_diet_catering_meals_diet_day
  ON diet_catering_meals (delivery_diet_id, day);
CREATE INDEX IF NOT EXISTS idx_diet_catering_meals_day
  ON diet_catering_meals (day) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_diet_catering_meals_product
  ON diet_catering_meals (simple_product_id);
CREATE INDEX IF NOT EXISTS idx_diet_catering_day_day
  ON diet_catering_day (day);
CREATE INDEX IF NOT EXISTS idx_diet_consumption_day
  ON diet_consumption (day) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_diet_consumption_catering_meal
  ON diet_consumption (catering_meal_id);
CREATE INDEX IF NOT EXISTS idx_diet_consumption_kind
  ON diet_consumption (kind);
CREATE INDEX IF NOT EXISTS idx_diet_products_categories
  ON diet_products USING GIN (categories);
CREATE INDEX IF NOT EXISTS idx_diet_products_allergens
  ON diet_products USING GIN (allergens);
```

(PK/UNIQUE btrees on `delivery_item_id`, `uuid`, `simple_product_id`, `delivery_diet_id`, `(delivery_diet_id, day)` are implicit.)

### Set-returning functions

Migration `supabase/migrations/20260517000200_diet_functions.sql`, `CREATE OR REPLACE`.

**`diet_consumed_day(p_tz TEXT)`** → one row per day present in `diet_catering_meals.day` ∪ `diet_consumption.day`:

- `day DATE`, `delivery_diet_id BIGINT` (NULL on ad-hoc-only days)
- `plan_target_kcal INT`, `planned_kcal NUMERIC`, `planned_protein_g`, `planned_carb_g`, `planned_fat_g`, `planned_fiber_g`, `planned_sugar_g`, `planned_salt_g` — from `diet_catering_day` (NULL if no delivery)
- `consumed_kcal`, `consumed_protein_g`, `consumed_carb_g`, `consumed_fat_g`, `consumed_saturated_fat_g`, `consumed_fiber_g`, `consumed_sugar_g`, `consumed_salt_g`
- `n_planned INT`, `n_skip INT`, `n_partial INT`, `n_swap INT`, `n_adhoc INT`

Effective-consumed algorithm: for each non-deleted `diet_catering_meals` row on `day`, find the latest non-deleted `diet_consumption` with `catering_meal_id = m.id` and `kind IN ('skip','partial','swap')` by `updated_at`; contribution = product nutrition × {none → 1, `skip` → 0, `partial` → `consumed_fraction`, `swap` → the `swap_product_id` product's nutrition × 1}. Add all non-deleted `kind='adhoc'` rows for the day. `kind='note'` and `deleted_at IS NOT NULL` excluded.

**`diet_weekly(p_tz TEXT)`** → `week_start DATE` (Monday) buckets: summed `consumed_*` and `planned_*`, summed deviation counts, `days_with_delivery INT`.

**`diet_energy_balance(p_tz TEXT)`** → per day: `day`, `intake_kcal` (= `consumed_kcal`), `active_kcal` (Σ `health_samples` `HKQuantityTypeIdentifierActiveEnergyBurned` where `(start_date AT TIME ZONE p_tz)::date = day AND deleted_at IS NULL`), `basal_kcal` (`HKQuantityTypeIdentifierBasalEnergyBurned`), `total_out_kcal` (active+basal), `net_kcal` (intake − total_out).

### Roles & grants

Migration `supabase/migrations/20260517000100_diet_roles.sql`. Two-layer pattern (NOLOGIN role in migration; LOGIN user in seed).

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='diet_writer_role') THEN
    CREATE ROLE diet_writer_role NOLOGIN;
  END IF;
END $$;

GRANT INSERT, UPDATE, SELECT ON diet_subscriptions   TO diet_writer_role;
GRANT INSERT, UPDATE, SELECT ON diet_products         TO diet_writer_role;
GRANT INSERT, UPDATE, SELECT ON diet_catering_meals   TO diet_writer_role;
GRANT INSERT, UPDATE, SELECT ON diet_catering_day     TO diet_writer_role;
GRANT INSERT, UPDATE, SELECT ON diet_consumption      TO diet_writer_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO diet_writer_role;

-- diet_add_note(scope='day') appends to daily_logs.notes via the diet writer pool.
-- daily_logs is the shared per-day lifestyle log (gym_writer_role already writes it,
-- per 20260514000000_daily_logs.sql); the diet writer needs the same access.
GRANT INSERT, UPDATE, SELECT ON daily_logs TO diet_writer_role;

-- Defense in depth: diet writer cannot touch other domains' write surfaces.
REVOKE ALL ON health_samples, device_state, summary_cache FROM diet_writer_role;
REVOKE ALL ON exercises, gyms, gym_machines,
              training_sessions, training_exercises, training_sets FROM diet_writer_role;
-- ...and other writers cannot touch diet_*.
REVOKE ALL ON diet_subscriptions, diet_products, diet_catering_meals,
              diet_catering_day, diet_consumption
  FROM gym_writer_role, health_ingest_role;

-- run_sql (read-only) over diet data + the functions.
GRANT SELECT ON diet_subscriptions, diet_products, diet_catering_meals,
                diet_catering_day, diet_consumption TO health_read_role;
GRANT EXECUTE ON FUNCTION diet_consumed_day(TEXT)    TO health_read_role, diet_writer_role;
GRANT EXECUTE ON FUNCTION diet_weekly(TEXT)          TO health_read_role, diet_writer_role;
GRANT EXECUTE ON FUNCTION diet_energy_balance(TEXT)  TO health_read_role, diet_writer_role;
```

`supabase/seed.sql` (and `deploy/install.sh`): create `diet_writer_user` LOGIN with a per-env password and `GRANT diet_writer_role TO diet_writer_user`.

## MCP surface

All `diet_*`. Write tools use a new `dietWritePool` (`MCP_DIET_WRITER_URL`). Output shape mirrors gym tools: `{ content: [{ type:'text', text: JSON.stringify(result) }] }`.

### Write tools

- **`diet_sync_subscriptions({ payload })`** — `payload` = raw `/delivery-diets` JSON. Upserts `diet_subscriptions` by `delivery_diet_id`. Returns `{ upserted: n }`.
- **`diet_sync_catering_day({ payload })`** — `payload` = raw `/deliveries` JSON for one day. One transaction: upsert `diet_products` from `includes.simple_products` (crc32-gated) → upsert `diet_catering_meals` by `delivery_item_id` → upsert `diet_catering_day` by `(delivery_diet_id, day)`. `result_count: 0` → `{ synced: 0, no_delivery: true }`. A referenced `simple_product_id` absent from `includes` → insert a minimal `diet_products` stub (nutrition null) and add it to a returned `warnings[]`. Never touches `diet_consumption`. Returns `{ products, meals, day, warnings[] }`.
- **`diet_log_meal({ uuid, date?, tz?, meal_slot_key?, name, kcal, protein_g?, carb_g?, fat_g?, saturated_fat_g?, fiber_g?, sugar_g?, salt_g?, weight_g?, source, photo_ref?, notes? })`** — `kind='adhoc'`. `date` defaults to today in `tz` (`tz` default `'UTC'`). Idempotent on `uuid`.
- **`diet_log_deviation({ uuid, kind, day?, tz?, meal_slot_key?, catering_meal_id?, consumed_fraction?, swap_product_id?, notes? })`** — `kind ∈ {skip,partial,swap}`. Resolves `catering_meal_id` from `(day, meal_slot_key)` against `diet_catering_meals` if not given (`day` defaults to today in `tz`; errors if ambiguous/none). The stored `diet_consumption.day` is taken from the resolved catering meal's `day` (so "I skipped yesterday's dinner" lands on the right day). Validates kind-specific fields. Idempotent on `uuid`.
- **`diet_update_entry({ uuid?, id?, … })`** — updates a `diet_consumption` row; COALESCE-preserves omitted fields (the `health_log_day` pattern). Not-found → error.
- **`diet_delete_entry({ uuid?, id? })`** — sets `deleted_at` on a `diet_consumption` row. Not-found → error. Catering tables are not tool-deletable.
- **`diet_add_note({ scope, text, day?, tz?, uuid?, id?, catering_meal_id?, meal_slot_key? })`** — `scope='day'` → newline-appends to `daily_logs.notes` for the local day (its own `INSERT … ON CONFLICT (day) DO UPDATE SET notes = …` that *appends*, inserting the row if absent — note the append vs `health_log_day`'s replace semantics); `scope='entry'` → newline-appends to the targeted `diet_consumption.notes`; `scope='meal'` → inserts a `diet_consumption` `kind='note'` row against a catering meal.

### Reads

No new read tools. `run_sql` (read-only `health_read_role`) over `diet_consumed_day(tz)` / `diet_weekly(tz)` / `diet_energy_balance(tz)` and the tables, plus `schema://tables`.

### Resource update — `schema://tables`

`mcp-server/src/resources/schema.ts` (`describeSchema`): add the 5 `diet_*` tables to the `information_schema` table list; document the 3 functions in the "Set-returning functions" section; add a "Diet / nutrition" prose section (the deviation model, that `note`/deleted rows are excluded, that catering tables are provider mirrors mutated only via `diet_sync_*`, and that `run_sql` is read-only on `diet_*` — mutate via `diet_*` tools); add example queries:

```sql
-- yesterday: consumed vs plan target
SELECT day, plan_target_kcal, consumed_kcal, consumed_protein_g,
       n_skip, n_partial, n_swap, n_adhoc
  FROM diet_consumed_day('Europe/Warsaw')
 WHERE day = current_date - 1;

-- weekly energy balance
SELECT day, intake_kcal, total_out_kcal, net_kcal
  FROM diet_energy_balance('Europe/Warsaw')
 WHERE day >= current_date - INTERVAL '7 days' ORDER BY day;

-- vegan catering days in the last 30
SELECT m.day, count(*) AS vegan_meals
  FROM diet_catering_meals m
  JOIN diet_products p ON p.simple_product_id = m.simple_product_id
 WHERE m.deleted_at IS NULL AND 'VEGAN' = ANY (p.categories)
   AND m.day >= current_date - 30
 GROUP BY m.day ORDER BY m.day DESC;

-- cross-domain: protein intake vs training volume that day
SELECT d.day, d.consumed_protein_g,
       COALESCE(SUM(ts.weight_kg * ts.reps), 0) AS gym_volume_kg
  FROM diet_consumed_day('Europe/Warsaw') d
  LEFT JOIN training_sessions s
    ON s.deleted_at IS NULL
   AND (s.started_at AT TIME ZONE 'Europe/Warsaw')::date = d.day
  LEFT JOIN training_exercises te ON te.session_id = s.id AND te.deleted_at IS NULL
  LEFT JOIN training_sets ts ON ts.training_exercise_id = te.id AND ts.deleted_at IS NULL
 WHERE d.day >= current_date - 14
 GROUP BY d.day, d.consumed_protein_g ORDER BY d.day DESC;
```

## `diet-coach` skill

`skill_example/diet-coach/SKILL.md`, same shape as `health-coach`/`gym-coach`.

**Frontmatter:** `name: diet-coach`; description covers catering sync, logging deviations, ad-hoc meals from photos (label or web-researched), notes, and diet/nutrition analysis via `run_sql`.

**Role:** nutrition-tracking partner with write access to the diet log. Captures what was actually eaten vs the catering plan; returns grounded numbers. The user's goals live with the agent, not the MCP. Never prescribes diets or makes medical claims.

**MCP surface table:** the `diet_*` tools + `run_sql` + `schema://tables`.

**Playbooks:**

1. **Catering sync (cron):** `diet_sync_subscriptions` once, then `diet_sync_catering_day` for today and any missed delivery days; skip non-delivery days (use `delivery_days[]` from the subscription). One-line confirm.
2. **Prev-day recap (cron):** `run_sql` `diet_consumed_day` + `diet_energy_balance` for yesterday → short recap vs plan target and energy out. The agent composes; it knows the user's goals.
3. **Photo — nutrition label visible:** vision reads the label → confirm portion/grams with the user → `diet_log_meal(source='label_photo')`.
4. **Photo — product, no label:** vision identifies the product → **web search** for nutrition (per 100 g / per portion) → show the user the values **and the source** → clarify grams/portion eaten → `diet_log_meal(source='web_research')`. When genuinely guessing, `source='estimate'` and say so.
5. **Deviation:** "ate half my lunch" → resolve today's slot → `diet_log_deviation(kind='partial', consumed_fraction=0.5)`. `skip` / `swap` analogously; for `swap`, resolve the alternative product (it is already in `diet_products` from the sync, usually within `alternative_product_ids`).
6. **Notes:** day / meal / entry → `diet_add_note`.
7. **Analysis:** custom and cross-domain (diet × gym × health) via `run_sql`; read `schema://tables` first.

**Behavior:** grams/kcal canonical; **always confirm portion before logging**; one-line confirmations; lead with the number vs the plan target; flag estimated nutrition; generate a fresh `uuid` per log call and reuse it on retry.

**Anti-patterns:** no logging without portion confirmation; no invented nutrition (label or web research only); no `run_sql` when a typed tool fits; no moralizing about food choices; no diagnosing. Coexists with `health-coach`/`gym-coach`; cross-domain questions are `run_sql` territory.

## MCP server changes (`mcp-server/src/index.ts`)

- Add `dietWritePool = createPool(process.env.MCP_DIET_WRITER_URL)`; throw at startup if unset (same guard style as `MCP_DATABASE_URL`/`MCP_GYM_WRITER_URL`). Close it in the server `close()`.
- New `mcp-server/src/tools/diet/{sync,log,edit,notes}.ts`; register the tools in `buildMcp`, wiring writes to `dietWritePool`.
- Extend `mcp-server/src/resources/schema.ts`.

## Testing

- **Sanitized fixtures:** `mcp-server/test/fixtures/ntfy-deliveries.json` and `ntfy-delivery-diets.json`, derived from the gitignored captures with `user_id`, `address_id(s)`, and price fields scrubbed. The raw PII captures are deleted once fixtures exist.
- **vitest** `mcp-server/src/tools/diet/{sync,log,edit}.test.ts` (local Postgres, `supabase db reset` first): subscription/product/meal/day upserts; idempotent re-run (no duplicates); crc32 skip; deviation math via `diet_consumed_day` (skip→0, partial fraction, swap product, adhoc add, note/deleted excluded, latest-wins); COALESCE update; soft-delete; no-delivery no-op; missing-product stub + `warnings[]`.
- **psql** `supabase/tests/diet_schema.test.sql` (tables, columns, indexes, the `kind`/`consumed_fraction` CHECKs) and `supabase/tests/diet_roles.test.sql` (`diet_writer_role` writes `diet_*` and is denied health/gym write tables; `gym_writer_role`/`health_ingest_role` denied `diet_*`; `health_read_role` SELECT + function EXECUTE).
- Update `mcp-server/src/resources/schema.test.ts` to assert the diet tables and functions are documented.
- Wire the new SQL test files into the README test loop.

## Deploy

- `deploy/.env.example`: add `MCP_DIET_WRITER_URL`.
- `deploy/docker-compose.mcp.yml`: pass `MCP_DIET_WRITER_URL` to the MCP service.
- `deploy/README.md`: document the new env var and the `diet_writer_user` creation step.
- `supabase/seed.sql` / `deploy/install.sh`: create `diet_writer_user` LOGIN + `GRANT diet_writer_role`.
- Migrations are additive/idempotent; an old MCP image keeps working against the new schema (it just lacks the diet tools).

## Risks & known behavior

- **Provider product change after a logged deviation:** `diet_catering_meals` keeps row identity by `delivery_item_id`; a re-sync may change its `simple_product_id`. A deviation references the slot, so `diet_consumed_day` uses the *current* product. Accepted and documented.
- **Missing product in `includes`:** handled via a nutrition-null stub + `warnings[]` (FK stays valid; `run_sql` still works).
- **Auth/session is Hermes-side:** if the `ntfy.pl` session expires, the fetch fails in Hermes; the MCP is unaffected. Re-running the sync after re-auth is safe (idempotent).
- **Timezone:** `diet_consumption.day` is the local date the tool computed from `tz`; `diet_catering_meals.day` is the provider's delivery date. Energy-balance day mapping uses `AT TIME ZONE p_tz`, matching the existing `daily_logs` example in `schema.ts`.

## Open questions

None blocking. Future (out of scope now): a second catering provider (the `raw JSONB` shadow eases it); promoting `diet_consumed_day` to a cached markdown tool if cron recaps get expensive; renaming writer roles to a generic scheme if a fourth domain appears.
