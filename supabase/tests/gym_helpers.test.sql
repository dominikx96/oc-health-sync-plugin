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
  INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg, rpe, without_break)
    VALUES ('st-mok-1', te_recent, 1, 10, 60, 8, true);

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
  END LOOP;
  IF rows_seen <> 2 THEN RAISE EXCEPTION 'expected 2 rows from last_exercise_results, got %', rows_seen; END IF;

  RAISE NOTICE 'gym_helpers.test.sql OK';
END $$;

TRUNCATE training_sets, training_exercises, training_sessions,
         gym_machines, exercises, gyms RESTART IDENTITY CASCADE;
