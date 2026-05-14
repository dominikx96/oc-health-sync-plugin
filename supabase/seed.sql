DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ingest_user') THEN
    CREATE ROLE ingest_user LOGIN PASSWORD 'ingest_pw' IN ROLE health_ingest_role;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'read_user') THEN
    CREATE ROLE read_user LOGIN PASSWORD 'read_pw' IN ROLE health_read_role;
  END IF;
END $$;

-- Local-dev convenience: allow ingest_user to TRUNCATE and seed test fixtures.
GRANT TRUNCATE ON health_samples, device_state, summary_cache TO ingest_user;
GRANT INSERT   ON summary_cache TO ingest_user;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gym_writer_user') THEN
    CREATE ROLE gym_writer_user LOGIN PASSWORD 'gym_writer_pw' IN ROLE gym_writer_role;
  END IF;
END $$;

-- Local-dev convenience: allow gym_writer_user to TRUNCATE gym tables for tests.
GRANT TRUNCATE ON exercises, gyms, gym_machines,
                  training_sessions, training_exercises, training_sets
  TO gym_writer_user;

-- daily_logs is owned (writes) by gym_writer_role; allow the local-dev login to TRUNCATE.
GRANT TRUNCATE ON daily_logs TO gym_writer_user;
