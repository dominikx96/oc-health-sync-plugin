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
