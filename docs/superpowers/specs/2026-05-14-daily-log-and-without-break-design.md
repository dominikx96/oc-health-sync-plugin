# oc-health-sync — Daily log table + `without_break` on training sets

**Date:** 2026-05-14
**Status:** Approved (brainstorming complete, awaiting implementation plan)
**Author:** Dominik Barcikowski (with Claude)

## Context

Two small, independent additions to `oc-health-sync`:

1. **Daily lifestyle log.** No table exists today for per-day, manually-entered health facts. `health_samples` is per-event HealthKit data; `daily_metrics(tz)` is a read-side view over those samples. The user wants to record "did I drink alcohol today?" plus a free-text notes field. The shape should be open enough that future per-day flags (medication, period, soreness, etc.) drop in without renaming, but the initial column set stays narrow.
2. **`without_break` flag on `training_sets`.** Sometimes an extra set is performed immediately after another with no rest (drop set, rest-pause, myo-reps, "just one more"). Today this is invisible in the data — every set looks like a separate planned set. A boolean per set lets future analysis distinguish continuous-rep work from rested sets.

Both changes follow the existing migration discipline (additive, idempotent, nullable / defaulted) so the previous MCP image keeps working against the new schema.

## Goals

1. Persist per-day lifestyle facts (initially: `alcohol` boolean + free-text `notes`) in a new `daily_logs` table, one row per local day.
2. Expose a single MCP write tool (`health_log_day`) that upserts a day's row, so the agent can record alcohol/notes without dropping to raw SQL.
3. Make the new table queryable via the existing `run_sql` tool and visible in the `schema://tables` resource.
4. Add a `without_break` boolean column to `training_sets`, default `false`, mirroring the existing `is_warmup` pattern.
5. Thread `without_break` through both write paths (`gym_log_set`, `gym_submit_session_bulk`) and the historical-lookup output (`last_exercise_results` JSONB).
6. Maintain rollback safety: the previous image must still function correctly against the new schema.

## Non-goals

- Per-drink event tracking (quantity, type, time of drink). One boolean per day is the scope.
- Speculative `daily_logs` columns (mood, sleep_quality_self, soreness, etc.). The table is named generically so they can be added later; we do not add them now.
- A separate role for `daily_logs` writes. Reuse `health_ingest_role`.
- Defining new technique-specific columns on `training_sets` (e.g. `is_drop_set`, `is_rest_pause`). `without_break = true` + decreasing weight is derivable in SQL when needed.
- iOS app changes. The new write tool lives in MCP only.
- Backfill of historical `without_break` data — every existing row stays `false`, which is the honest unknown.

## Decisions

| | Decision | Rationale |
|---|---|---|
| Daily-log granularity | One row per local day, `day DATE PRIMARY KEY` | "Did I drink today?" is a daily fact; per-event tracking is a separate future table. |
| Daily-log timezone handling | Store `day DATE` plus a `tz TEXT` snapshot of the IANA zone used to derive `day` | Lines up with `daily_metrics(p_tz)` which already takes a tz; lets cross-domain joins match days unambiguously. |
| `alcohol` nullability | `BOOLEAN NULL` (no default) | `NULL` = not logged, `false` = explicitly sober, `true` = drank. Required to distinguish "didn't log" from "logged false". |
| Table name | `daily_logs` (generic) | Future booleans (`took_meds`, `period_day`, etc.) drop in as ALTER TABLE without renaming or migrating. |
| `notes` shape | Single `TEXT` column, last-write-wins on upsert | Same pattern as `training_sessions.notes`; the table is small and the conversation can read+rewrite if append semantics are needed. |
| Write path for `daily_logs` | New MCP tool `health_log_day` doing upsert | Established pattern (dedicated tools for writes, `run_sql` for reads); keeps role separation clean. |
| Write role for `daily_logs` | `health_ingest_role` | Already has INSERT/UPDATE on health tables; no new role required. |
| Read role for `daily_logs` | `health_read_role` (SELECT) | Inherited via `ALTER DEFAULT PRIVILEGES` in `20260507000100_roles.sql`; explicit GRANT is added defensively in the new migration. |
| Schema resource exposure | Add `'daily_logs'` to the table allowlist in `resources/schema.ts` and add a short prose section describing it | Column introspection is automatic; the prose section signals intent and shows example writes. |
| `without_break` shape | `BOOLEAN NOT NULL DEFAULT false` on `training_sets` | Exact mirror of `is_warmup`; defaulted so existing rows stay valid and old image still works. |
| `without_break` naming | `without_break` (as requested) | Literal description, avoids overloading drop-set / rest-pause / myo-rep terminology. |
| `without_break` in lookups | Add to `last_exercise_results` JSONB output (`CREATE OR REPLACE FUNCTION`) | Lets the agent see prior continuous-rep history when planning the next set. |
| Migration shape | Two separate migrations (one per concern) | Easier to revert one independently; matches the granular per-feature migration pattern already in the repo. |
| Tests | SQL test for `daily_logs` schema + role grants; round-trip TS tests for `health_log_day`; positive `without_break` test in `gym_schema.test.sql` + round-trip in `sets.test.ts` / `bulk.test.ts` | Same coverage shape as the gym-tracker rollout. |

## Architecture

```
┌──────────────────────────────┐         ┌────────────────────────────────────┐
│ MCP client (Claude Desktop)  │         │ Tailnet-only MCP server (Node 24)  │
│ + health-coach skill         │ ──HTTP──▶│  ┌─ readPool (read_user) ─────────┐│
│ + gym-coach skill            │         │  │  schema, search_*, last_*,     ││
└──────────────────────────────┘         │  │  current_session, run_sql      ││
                                         │  └────────────────────────────────┘│
                                         │  ┌─ ingestPool (ingest_user) ─────┐│
                                         │  │  health_log_day  (NEW)          ││
                                         │  └────────────────────────────────┘│
                                         │  ┌─ writePool (gym_writer) ───────┐│
                                         │  │  start/finish/log_set (+w_b),  ││
                                         │  │  submit_bulk (+w_b)             ││
                                         │  └────────────────────────────────┘│
                                         └─────────────────┬──────────────────┘
                                                           │
                                          ┌────────────────▼───────────────┐
                                          │ Postgres                       │
                                          │  health_samples (existing)     │
                                          │  daily_logs (NEW)              │
                                          │  device_state, summary_cache   │
                                          │  exercises, gyms, gym_machines │
                                          │  training_sessions             │
                                          │  training_exercises            │
                                          │  training_sets (+without_break)│
                                          └────────────────────────────────┘
```

A note on the third pool: there is no dedicated "ingest" pool in the MCP server today — health writes happen via the Edge Function, not MCP. `health_log_day` is the first MCP-side write to a health-domain table. The implementation will either:

- (a) reuse the existing `writePool` and grant `gym_writer_role` `INSERT, UPDATE, SELECT` on `daily_logs` (mixing domains in one role — undesirable), **or**
- (b) introduce a third pool wired to a `health_ingest_user` LOGIN role that inherits `health_ingest_role`, parallel to how `gym_writer_user` was added.

The implementation plan should choose **(b)** to keep role separation clean and match the existing two-layer (NOLOGIN role + LOGIN user) pattern. Env var: `MCP_HEALTH_INGEST_URL`. Seed.sql and `deploy/install.sh` / `deploy/upgrade.sh` env-var backfill need to add the new user.

## Schema

### Migration 1 — `20260514000000_daily_logs.sql`

```sql
CREATE TABLE IF NOT EXISTS daily_logs (
  day         DATE        PRIMARY KEY,
  tz          TEXT        NOT NULL,
  alcohol     BOOLEAN,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Explicit grants (idempotent; ALTER DEFAULT PRIVILEGES covers SELECT but write grants must be explicit).
GRANT SELECT                  ON daily_logs TO health_read_role;
GRANT INSERT, UPDATE, SELECT  ON daily_logs TO health_ingest_role;

-- Local-dev convenience for the ingest_user (matches existing seed.sql pattern for health_samples).
-- This GRANT lives in seed.sql, not here, but is mentioned for completeness:
--   GRANT TRUNCATE ON daily_logs TO ingest_user;
```

### Migration 2 — `20260514000100_training_sets_without_break.sql`

```sql
ALTER TABLE training_sets
  ADD COLUMN IF NOT EXISTS without_break BOOLEAN NOT NULL DEFAULT false;
```

### Migration 3 — `20260514000200_last_exercise_results_v2.sql`

`CREATE OR REPLACE FUNCTION last_exercise_results(...)` — same signature, same body except the JSONB row builder gains one key:

```sql
jsonb_build_object(
  'set_index',     ts.set_index,
  'reps',          ts.reps,
  'weight_kg',     ts.weight_kg,
  'rpe',           ts.rpe,
  'is_warmup',     ts.is_warmup,
  'without_break', ts.without_break,   -- NEW
  'notes',         ts.notes
)
```

Because the function signature is unchanged, the old MCP image continues to call it and simply doesn't read the new key from the JSON — rollback-safe.

### Seed (`supabase/seed.sql`)

Add a third LOGIN role (`health_ingest_user`) inheriting `health_ingest_role`, parallel to `gym_writer_user`:

```sql
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'health_ingest_user') THEN
    CREATE ROLE health_ingest_user LOGIN PASSWORD 'health_ingest_pw' IN ROLE health_ingest_role;
  END IF;
END $$;

-- Local-dev convenience for the new daily_logs table.
GRANT TRUNCATE ON daily_logs TO health_ingest_user;
```

Production password is generated and stored in `deploy/.env` by `install.sh` (existing pattern); `upgrade.sh` backfills the env var on existing deployments.

## MCP surface

### New write tool — `health_log_day`

```ts
inputSchema: z.object({
  date:    z.string().optional(),     // YYYY-MM-DD; defaults to "today" in the supplied tz
  tz:      z.string().optional(),     // IANA tz; defaults to 'UTC'
  alcohol: z.boolean().optional(),    // NULL = leave unchanged on upsert
  notes:   z.string().optional()      // NULL = leave unchanged on upsert
})
```

Semantics:

- Resolves `day` as `(now() AT TIME ZONE tz)::date` if `date` is omitted, else parses `date` as `DATE`.
- Upsert: `INSERT … ON CONFLICT (day) DO UPDATE SET alcohol = COALESCE(EXCLUDED.alcohol, daily_logs.alcohol), notes = COALESCE(EXCLUDED.notes, daily_logs.notes), tz = EXCLUDED.tz, updated_at = now()`.
- Calling with only `alcohol` set leaves any prior `notes` untouched, and vice versa. To explicitly clear a field, use `run_sql` (privileged).
- Returns the resulting row.

### Modified write tools

- `gym_log_set` — input gains `without_break?: z.boolean().optional()`; passed through to the INSERT (`COALESCE($N, false)` like `is_warmup`).
- `gym_submit_session_bulk` — `SetSchema` in `bulk.ts` gains `without_break: z.boolean().optional()`; piped to the INSERT.

### Read resources

`mcp-server/src/resources/schema.ts`:

1. Add `'daily_logs'` to the `table_name IN (…)` allowlist in the introspection query so the column table appears in `schema://tables`.
2. Add a short prose section after the existing "Tables" section documenting `daily_logs`:

   > `daily_logs` — one row per local day. `day` is the local date in `tz`. `alcohol BOOLEAN` is `NULL` until logged. `notes TEXT` is last-write-wins. Use the `health_log_day` MCP tool to upsert; querying via `run_sql` is read-only.

3. Add one example query in "Example queries":

   ```sql
   -- alcohol days in the last 30, joined with HRV the next morning
   SELECT dl.day, dl.alcohol,
          AVG(hs.value) FILTER (WHERE hs.data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN')
     FROM daily_logs dl
     LEFT JOIN health_samples hs ON hs.deleted_at IS NULL
      AND (hs.start_date AT TIME ZONE dl.tz)::date = dl.day + INTERVAL '1 day'
    WHERE dl.day >= current_date - INTERVAL '30 days'
    GROUP BY dl.day, dl.alcohol
    ORDER BY dl.day DESC;
   ```

4. `without_break` is auto-introspected on `training_sets` — no allowlist change needed, but the existing example query block for gym data could note it. Optional polish, not required for correctness.

## Server wiring (`mcp-server/src/index.ts`)

- Read `MCP_HEALTH_INGEST_URL` and fail-fast if unset (same shape as `MCP_DATABASE_URL` / `MCP_GYM_WRITER_URL`).
- Create a third pool `healthIngestPool` and pass it to `buildMcp`.
- Register `health_log_day` against `healthIngestPool`.
- Pass `without_break` through in the existing `gym_log_set` and `gym_submit_session_bulk` registrations.

## Tests

| Area | New / changed test | Verifies |
|---|---|---|
| `supabase/tests/daily_logs_schema.test.sql` (new) | Table exists, PK on `day`, nullable `alcohol`, NOT NULL `tz`/`created_at`/`updated_at` | Schema shape matches design |
| `supabase/tests/daily_logs_roles.test.sql` (new) | `health_ingest_role` can INSERT/UPDATE; `health_read_role` can only SELECT; `gym_writer_role` cannot SELECT | Role separation holds |
| `supabase/tests/gym_schema.test.sql` (extend) | `training_sets.without_break` column exists with default `false` | Column add applied |
| `mcp-server/test/tools/health-log-day.test.ts` (new) | Round-trip: upsert new day, upsert same day with new field, COALESCE preserves prior fields, returns resulting row | Tool contract |
| `mcp-server/test/tools/gym/sets.test.ts` (extend) | `logSet` with `without_break: true` persists and reads back | Pass-through |
| `mcp-server/test/tools/gym/bulk.test.ts` (extend) | Bulk import with `without_break: true` on at least one set persists correctly | Pass-through |
| `mcp-server/test/resources/schema.test.ts` (extend) | `schema://tables` output includes `daily_logs` and a `without_break` column on `training_sets` | Discoverability |

## Deploy

- `deploy/install.sh` — generate a password for `health_ingest_user`, write `MCP_HEALTH_INGEST_URL` into `deploy/.env`.
- `deploy/upgrade.sh` — env-var backfill block (same one that backfilled `MCP_GYM_WRITER_URL`) gains a stanza for `MCP_HEALTH_INGEST_URL`; idempotent.
- `deploy/docker-compose.yml` — `mcp-server` service gains the new env var.
- `deploy/README.md` — short note: new env var, what it's for.

## Risks & migration safety

- **Old image continues to run.** Both schema migrations are additive with defaults; `last_exercise_results` keeps its signature, only extends the JSON; old code paths are unaffected.
- **Forgetting `MCP_HEALTH_INGEST_URL`.** Server fails fast at startup with a clear message ("MCP_HEALTH_INGEST_URL is not set") — same pattern as the other two DSNs. Caught immediately, not silently.
- **`alcohol = NULL` semantics.** Documented in the table prose and the tool description; the upsert COALESCE logic makes "leave unchanged" the only way the tool can write `NULL`, so accidental nulling is hard.
- **`without_break` historical interpretation.** Every existing row defaults to `false` — i.e. "no continuous-rep marker present". Documented in the `last_exercise_results` prose update so the agent doesn't over-claim about pre-feature sessions.
- **Cross-domain join correctness.** The example query in `schema.ts` joins `daily_logs` with `health_samples` using the stored `tz` — correct because the tz snapshot belongs to the row that recorded the day.

## Open questions

None — all five gating decisions confirmed during brainstorming (see chat history): `alcohol` nullable boolean; table name `daily_logs`; dedicated `health_log_day` upsert tool; column name `without_break` with `NOT NULL DEFAULT false`; `last_exercise_results` JSONB extended.
