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
