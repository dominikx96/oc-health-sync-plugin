# oc-health-sync — Gym Tracker

**Date:** 2026-05-11
**Status:** Approved (brainstorming complete, awaiting implementation plan)
**Author:** Dominik Barcikowski (with Claude)

## Context

`oc-health-sync` today ingests Apple HealthKit data via an iOS app → Supabase Edge Function pipeline and exposes it through an MCP server (`health_summary`, `health_anomalies`, `run_sql` + `schema://tables`). There is no gym-tracking capability.

This design adds a gym/training tracker that lives alongside HealthKit ingest in the same repo, same Postgres, same MCP server. All writes go through MCP (no iOS path). A new `gym-coach` skill drives the user-facing flow.

Co-locating gym data with HealthKit data unlocks future cross-domain analysis (recovery × training load, HRV × session rating) via plain SQL joins.

## Goals

1. Log a gym session live from the conversation: start → log sets → finish, with each set persisted immediately so a dropped connection or fresh chat does not lose data.
2. Compare against the past: a session-level summary at start (last same-type session at this gym + last anywhere) and a per-exercise lookup when each exercise is named (last at this gym + last anywhere).
3. Capture free-text notes at three scopes: per set, per exercise, per session.
4. Capture a 1–10 session rating at finalize.
5. Support bulk-importing a finished session from paper/notepad notes via a single atomic tool call.
6. Track which physical machine (gym, manufacturer, model) was used, while keeping `exercises` as a clean catalog of abstract movements so the same movement at different gyms compares cleanly.
7. Ship a `gym-coach` skill that drives the live flow, enforces catalog discipline (search → confirm → create), and stays out of the way between sets.

## Non-goals

- iOS app changes. HealthKit-only stays. The iOS path will not write gym data.
- Multi-user / tenancy. Single-user, no `user_id` columns. Easy to add later.
- Programming, periodization, or form coaching. The agent reports numbers and notes — it does not prescribe.
- Tools for editing or deleting sets. Corrections happen via a privileged `run_sql` session.
- Built-in analytics tools (1RM estimate, weekly tonnage, etc.). `run_sql` over the new tables suffices for now.
- Auto-close of stale "open" sessions via cron. Handled lazily via a `force=true` flag on `gym_start_session`.
- Public exposure. Stays tailnet-only, same as the rest of the system.

## Decisions

| | Decision | Rationale |
|---|---|---|
| Housing | Extend `oc-health-sync` (same repo, same DB, same MCP server) | Shared infra, deploy, and Tailscale; enables cross-domain SQL joins with `health_samples`. |
| Tenancy | Single-user, no `user_id` columns | Matches current `health_samples` stance. Reversible if a second user ever appears. |
| Exercise/machine modeling | `exercises` (abstract movement) + `gym_machines` (per-gym instance with manufacturer/model). A logged set references both, machine nullable. | Same "Low Row" at two gyms is one exercise, two machine rows — cross-gym comparison is one query. |
| Session lifecycle | Persist-as-you-go: open session in DB (`ended_at IS NULL`) + explicit `gym_finish_session` | Nothing lost mid-workout; resumable via `gym_current_session`. |
| Idempotency | Client-generated UUIDs on `training_sessions` and `training_sets` | Same pattern as `health_samples.uuid`. Retry-safe. |
| Comparison granularity | Both: session-level summary at start AND per-exercise lookup mid-session | Matches the user's explicit "two lasts" requirement. |
| Catalog policy | Empty start; agent searches before creating; user confirms unknowns; no fuzzy-merge server-side | Discipline carried by the skill. Server is honest about what exists; user gates new entries. |
| Bulk import | A single `gym_submit_session_bulk` tool with the full session payload; `source='bulk'` flag on the session row | Same data model as live sessions; importable from notepad. |
| Bulk catalog handling | Bulk import **rejects** unknown exercise/gym/machine slugs and returns them as a list | Forces the search → confirm → create protocol even for bulk; prevents typo-permanent rows. |
| Skill split | New `gym-coach` skill, separate from `health-coach` | Sharp scope per skill; the model follows shorter skills more reliably. |
| Units | kg canonical; agent converts lbs at input | Single store, no per-set unit column. |
| Open-session uniqueness | Partial-unique index on `training_sessions((true)) WHERE ended_at IS NULL AND deleted_at IS NULL` | DB enforces "at most one open session"; `force=true` auto-finalizes a stale one. |
| Roles | New `gym_writer` Postgres role for write tools; existing `read_user` granted SELECT on new tables | Defense in depth: write tools cannot accidentally write to `health_samples`; `run_sql` works on gym data. |
| Migration discipline | All additive, idempotent, nullable defaults; old MCP image continues to function against new schema | Repo rule from `CONTRIBUTING.md`. |

## Architecture

```
┌──────────────────────────────┐         ┌────────────────────────────────────┐
│ MCP client (Claude Desktop)  │         │ Tailnet-only MCP server (Node 24)  │
│ + gym-coach skill            │ ──HTTP──▶│  ┌─ readPool (read_user) ─────────┐│
│ + health-coach skill         │         │  │  schema, search_*, last_*,     ││
└──────────────────────────────┘         │  │  current_session, run_sql      ││
                                         │  └────────────────────────────────┘│
                                         │  ┌─ writePool (gym_writer) ───────┐│
                                         │  │  start/finish/log/add_note,    ││
                                         │  │  create_*, submit_bulk         ││
                                         │  └────────────────────────────────┘│
                                         └─────────────────┬──────────────────┘
                                                           │
                                          ┌────────────────▼───────────────┐
                                          │ Postgres                       │
                                          │  health_samples (existing)     │
                                          │  device_state, summary_cache   │
                                          │  exercises, gyms, gym_machines │
                                          │  training_sessions             │
                                          │  training_exercises            │
                                          │  training_sets                 │
                                          └────────────────────────────────┘
```

iOS app keeps writing `health_samples` only — unchanged. Cross-domain reads (e.g. "HRV the day after a heavy pull") use a single SQL join via `run_sql`.

## Database schema

One additive migration creates 6 tables, 2 set-returning functions, 1 view, and indexes.

### Tables

```sql
-- Abstract movement. Empty on init; grown via MCP after agent confirmation.
CREATE TABLE IF NOT EXISTS exercises (
  id                BIGSERIAL PRIMARY KEY,
  slug              TEXT NOT NULL UNIQUE,
  display_name      TEXT NOT NULL,
  primary_muscle    TEXT NOT NULL,
  secondary_muscles TEXT[] NOT NULL DEFAULT '{}',
  mechanic          TEXT,                 -- 'compound' | 'isolation' | NULL
  equipment_class   TEXT NOT NULL,        -- 'machine'|'cable'|'dumbbell'|'barbell'|'bodyweight'|'other'
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

-- Physical machine at a specific gym. Free-weight movements skip this.
CREATE TABLE IF NOT EXISTS gym_machines (
  id            BIGSERIAL PRIMARY KEY,
  gym_id        BIGINT NOT NULL REFERENCES gyms(id),
  exercise_id   BIGINT NOT NULL REFERENCES exercises(id),
  manufacturer  TEXT,                     -- 'Technogym', 'Precor', 'Hammer Strength'
  model         TEXT,                     -- 'Selection 700 Low Row'
  label         TEXT,                     -- gym's printed label
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ,
  UNIQUE (gym_id, exercise_id, manufacturer, model)
);

CREATE TABLE IF NOT EXISTS training_sessions (
  id          BIGSERIAL PRIMARY KEY,
  uuid        TEXT NOT NULL UNIQUE,
  gym_id      BIGINT NOT NULL REFERENCES gyms(id),
  type        TEXT NOT NULL,              -- push|pull|legs|upper|lower|full|cardio|mobility|other
  started_at  TIMESTAMPTZ NOT NULL,
  ended_at    TIMESTAMPTZ,                -- NULL while open
  rating      SMALLINT,                   -- 1..10
  notes       TEXT,
  source      TEXT NOT NULL DEFAULT 'live', -- 'live' | 'bulk'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at  TIMESTAMPTZ,
  CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
  CHECK (type IN ('push','pull','legs','upper','lower','full','cardio','mobility','other')),
  CHECK (source IN ('live','bulk'))
);

CREATE TABLE IF NOT EXISTS training_exercises (
  id              BIGSERIAL PRIMARY KEY,
  uuid            TEXT NOT NULL UNIQUE,
  session_id      BIGINT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  exercise_id     BIGINT NOT NULL REFERENCES exercises(id),
  gym_machine_id  BIGINT REFERENCES gym_machines(id),
  position        INTEGER NOT NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  UNIQUE (session_id, position)
);

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
  CHECK (rpe IS NULL OR rpe BETWEEN 1 AND 10),
  CHECK (reps IS NOT NULL OR duration_seconds IS NOT NULL OR distance_m IS NOT NULL),
  UNIQUE (training_exercise_id, set_index)
);
```

### Indexes

```sql
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

CREATE INDEX IF NOT EXISTS idx_te_session    ON training_exercises (session_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_te_exercise   ON training_exercises (exercise_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sets_te_idx   ON training_sets (training_exercise_id, set_index) WHERE deleted_at IS NULL;
```

### Set-returning helpers

```sql
-- For the start-of-session summary tool.
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
  -- Returns up to 2 rows: most-recent same-gym session, then most-recent
  -- non-same-gym session, both of the requested type, both finalized.
$$;

-- For the per-exercise lookup mid-session.
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
  sets                 JSONB  -- [{set_index, reps, weight_kg, rpe, is_warmup, notes}]
) LANGUAGE sql STABLE AS $$
  -- Same shape: up to 2 rows, most-recent at this gym + most-recent anywhere else.
$$;

CREATE OR REPLACE VIEW current_open_session AS
  SELECT * FROM training_sessions
   WHERE deleted_at IS NULL AND ended_at IS NULL;
```

### Roles & grants

A second migration creates the write role and extends the read role:

```sql
DO $$ BEGIN
  CREATE ROLE gym_writer LOGIN PASSWORD 'set-via-env';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

GRANT INSERT, UPDATE, SELECT
  ON exercises, gyms, gym_machines,
     training_sessions, training_exercises, training_sets
  TO gym_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gym_writer;

GRANT SELECT
  ON exercises, gyms, gym_machines,
     training_sessions, training_exercises, training_sets,
     current_open_session
  TO read_user;
GRANT EXECUTE ON FUNCTION last_sessions_by_type(TEXT, BIGINT),
                          last_exercise_results(BIGINT, BIGINT)
  TO read_user;
```

## MCP surface

All new tools prefixed `gym_`. 13 tools + 1 resource update.

### Write tools (use `writePool` / `gym_writer`)

| Tool | Inputs | Behavior |
|---|---|---|
| `gym_start_session` | `gym_id \| gym_slug`, `type`, `started_at?`, `force?` | Fails if another session is open unless `force=true` (then auto-finalizes the stale one with `notes='auto-closed'`). Returns `{ session_id, session_uuid }`. |
| `gym_log_set` | `session_id`, **either** `training_exercise_id` (reuse existing block) **or** (`exercise_id \| exercise_slug`, `gym_machine_id?`) to start a new block, `set_uuid`, `reps?`, `weight_kg?`, `duration_seconds?`, `distance_m?`, `rpe?`, `is_warmup?`, `notes?`, `performed_at?`, `set_index?` | If `training_exercise_id` is given, appends to that block. Otherwise creates a new `training_exercises` row (server assigns `position`) and returns its id — the skill MUST reuse this id for subsequent sets of the same exercise within the session. Inserts the set. `set_index` auto-assigned if missing. Re-sending `set_uuid` is a no-op. At least one of `reps`/`duration_seconds`/`distance_m` is required (DB CHECK). |
| `gym_add_note` | `session_id`, `scope: 'set'\|'exercise'\|'session'`, `target_id?`, `text` | Newline-appends to `notes` on the targeted row. `target_id` required for set/exercise scopes. |
| `gym_finish_session` | `session_id`, `rating?`, `notes?`, `ended_at?` | Sets `ended_at`, `rating`, appends `notes`. Returns a finalized summary. |
| `gym_submit_session_bulk` | full payload (below) | Atomic. `source='bulk'`. Idempotent on `session_uuid`. Rejects unknown catalog slugs. |
| `gym_create_exercise` | `slug`, `display_name`, `primary_muscle`, `secondary_muscles?`, `mechanic?`, `equipment_class` | Idempotent on `slug`. |
| `gym_create_gym` | `slug`, `display_name`, `city?`, `notes?` | Idempotent on `slug`. |
| `gym_create_machine` | `gym_id`, `exercise_id`, `manufacturer?`, `model?`, `label?` | Idempotent on `(gym_id, exercise_id, manufacturer, model)`. |

### Read tools (use existing `pool` / `read_user`)

| Tool | Inputs | Returns |
|---|---|---|
| `gym_search_exercises` | `query?`, `limit?` | Candidate exercises (trigram fuzzy on `display_name`/`slug`). |
| `gym_search_gyms` | `query?`, `limit?` | Candidate gyms. |
| `gym_search_machines` | `gym_id`, `exercise_id?`, `query?` | Candidate machines at a gym, optionally filtered by exercise. |
| `gym_current_session` | — | Open session row or null. |
| `gym_last_session_summary` | `type`, `gym_id` | Up to 2 rows via `last_sessions_by_type`. |
| `gym_last_exercise_results` | `exercise_id \| exercise_slug`, `current_gym_id` | Up to 2 rows via `last_exercise_results`. |

### Bulk-import payload

```jsonc
{
  "session_uuid": "client-uuid",
  "gym_slug": "fitfabric-wola",
  "type": "pull",
  "started_at": "2026-05-08T17:30:00Z",
  "ended_at":   "2026-05-08T18:45:00Z",
  "rating": 7,
  "notes": "Felt heavy, low back tight on deadlifts.",
  "exercises": [
    {
      "exercise_slug": "seated-cable-row",
      "exercise_uuid": "client-uuid",
      "machine": { "manufacturer": "Technogym", "model": "Selection 700 Low Row" },
      "notes": "Form felt good",
      "sets": [
        { "set_uuid": "...", "reps": 12, "weight_kg": 50, "rpe": 7 },
        { "set_uuid": "...", "reps": 10, "weight_kg": 55, "rpe": 8 },
        { "set_uuid": "...", "reps":  8, "weight_kg": 60, "rpe": 9 }
      ]
    }
  ]
}
```

If any `exercise_slug`, `gym_slug`, or referenced machine is unknown, the tool returns a structured error with the full list — the skill walks the user through `gym_search_*` / `gym_create_*` and resubmits.

### Resource update

`schema://tables` gains a "Gym tables" section listing the new tables, the helpers (`last_sessions_by_type`, `last_exercise_results`), `current_open_session`, and 3 example queries:

1. Most recent push session at a specific gym.
2. Total volume by week across all gyms.
3. Cross-domain: average session rating bucketed by the prior night's HRV.

## `gym-coach` skill

New `skill_example/gym-coach/SKILL.md`, structured to mirror `skill_example/health-coach/SKILL.md`.

### Frontmatter

```yaml
---
name: gym-coach
description: Use when logging gym sessions live or importing a paper/notepad workout to oc-health-sync — starting/ending sessions, logging sets with reps/weight, comparing against last time, capturing notes per set/exercise/session.
---
```

### Sections

1. **Role.** Training partner with write access. Capture sets, compare to last time, stay out of the way. Never coach form or programming.
2. **MCP surface table.** The 13 tools grouped Write / Read.
3. **Playbooks.** Four named flows — Start, Per Exercise, Finish, Bulk Import (detailed below).
4. **Catalog discipline.** Hard rule: search before creating, ask the user before creating, no silent creates.
5. **Behavior.** kg canonical (convert lbs at input), one-line confirms between sets, lead with last-time numbers, round weights to 0.5 kg.
6. **Anti-patterns.** No paragraph echoes between sets, no programming advice, no silent catalog creates, no `run_sql` when a typed tool fits.
7. **Cross-domain note.** Both skills can be active; cross-domain questions are `run_sql` territory.

### Playbooks

**Start**
1. `gym_current_session` → if open <6h ago, ask resume/finish; if >6h ago, suggest `force=true`.
2. Resolve gym (search → confirm → create-if-needed).
3. Ask type.
4. `gym_start_session`.
5. `gym_last_session_summary` → read both rows in one line each.

**Per exercise**
1. User names exercise → `gym_search_exercises`.
2. One strong match → silent use; multiple → ask user; none → confirm a new entry and `gym_create_exercise`.
3. Optional machine resolution.
4. `gym_last_exercise_results` → read both rows.
5. First set: `gym_log_set` with `exercise_id` (+ optional `gym_machine_id`). Keep the returned `training_exercise_id`.
6. Subsequent sets: `gym_log_set` with that `training_exercise_id`. One-line confirm.
7. Notes mid-set → on the `gym_log_set` call; notes after → `gym_add_note(scope='exercise', target_id=training_exercise_id)`.

**Finish**
1. Ask 1–10 rating + overall notes.
2. `gym_finish_session`.
3. Brief delta vs prior same-type session.

**Bulk import**
1. Parse notepad text into the payload shape.
2. Resolve all catalog references (search-first, user-confirm) before submitting.
3. `gym_submit_session_bulk`.
4. Read back finalized summary.

## MCP server changes

- New env var `MCP_GYM_WRITER_URL` (postgres URL for `gym_writer`). Documented in `deploy/.env.example`.
- `mcp-server/src/db.ts` exposes two pools: existing `pool` (read-only) and new `writePool`.
- New folder `mcp-server/src/tools/gym/` with one file per tool group:
  - `session.ts` — `start_session`, `finish_session`, `current_session`
  - `sets.ts` — `log_set`, `add_note`
  - `catalog.ts` — `search_*` + `create_*` for exercises, gyms, machines
  - `bulk.ts` — `submit_session_bulk` with Zod-validated payload
  - `lookup.ts` — `last_session_summary`, `last_exercise_results`
- `mcp-server/src/resources/schema.ts` extended with the "Gym tables" section.

Existing tool files (`health-summary.ts`, `health-anomalies.ts`, `run-sql.ts`) are untouched.

## Testing

Three layers, mirroring existing patterns:

- **Schema tests** (`supabase/tests/gym.test.sql`): partial-unique open-session index, both set-returning functions on seeded fixtures, rating CHECK constraints, soft-delete behavior.
- **MCP unit tests** (`mcp-server/src/tools/gym/*.test.ts`): each tool against local Postgres after `supabase db reset`. Happy path + idempotency on `set_uuid` + bulk-import unknown-slug rejection.
- **Bulk-import golden file**: a notepad-style JSON payload checked in under `mcp-server/test/fixtures/`, exercised end-to-end against a clean DB.

## Release plan

Single feature branch `feat/gym-tracker`. Order of commits:

1. `20260511000000_init_gym_tables.sql` — tables, indexes, helpers, view (additive only).
2. `20260511000100_gym_roles.sql` — `gym_writer` role + grants (idempotent).
3. `mcp-server/src/db.ts` writePool wiring + env var + `deploy/.env.example` update.
4. Tools (`mcp-server/src/tools/gym/`), one file at a time with tests.
5. `schema://tables` resource update.
6. `skill_example/gym-coach/SKILL.md`.
7. README + deploy docs update.

Cut as a **minor** release (`vX.Y.0`) per the `CONTRIBUTING.md` semver rule (new MCP tools).

## Open questions

None at brainstorm close. Real-use feedback after first live and bulk sessions may surface follow-ups (likely candidates: an edit/delete-set tool, programmable rest timers in the skill, exercise merging once catalog has ~50 rows).
