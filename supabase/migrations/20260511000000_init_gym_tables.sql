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
