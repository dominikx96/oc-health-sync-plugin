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

  -- 4b. without_break is BOOLEAN NOT NULL; default-false applies to new rows;
  -- explicit true round-trips. (We don't assert column_default's text form — it
  -- varies by Postgres version. The behavioral check below is what matters.)
  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'training_sets'
     AND column_name = 'without_break' AND data_type = 'boolean' AND is_nullable = 'NO';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expected without_break BOOLEAN NOT NULL on training_sets';
  END IF;

  -- Default-false applies to a row inserted without the column.
  IF (SELECT without_break FROM training_sets WHERE uuid = 'st-ok') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'expected without_break default false on st-ok, got %', (SELECT without_break FROM training_sets WHERE uuid = 'st-ok');
  END IF;

  -- Explicit true is stored.
  INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, without_break)
    VALUES ('st-no-break', te_id, 2, 8, true);
  IF (SELECT without_break FROM training_sets WHERE uuid = 'st-no-break') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'expected without_break=true on st-no-break, got %', (SELECT without_break FROM training_sets WHERE uuid = 'st-no-break');
  END IF;

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
