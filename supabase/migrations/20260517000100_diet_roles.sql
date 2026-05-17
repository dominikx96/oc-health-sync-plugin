-- Diet writer role: INSERT/UPDATE/SELECT on diet tables only; cannot touch health_samples or gym tables.
-- Matches the existing two-layer pattern (NOLOGIN role + LOGIN user in seed.sql).

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
-- NOTE: GRANT EXECUTE ON FUNCTION diet_consumed_day/diet_weekly/diet_energy_balance
--       is intentionally omitted here; those functions are created in Task 3
--       (migration 20260517000200_diet_functions.sql) which owns those grants.
