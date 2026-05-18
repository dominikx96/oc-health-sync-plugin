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

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diet_writer_user') THEN
    CREATE ROLE diet_writer_user LOGIN PASSWORD 'diet_writer_pw' IN ROLE diet_writer_role;
  END IF;
END $$;

-- Local-dev convenience: allow diet_writer_user to TRUNCATE diet tables for tests.
GRANT TRUNCATE ON diet_subscriptions, diet_products, diet_catering_meals,
                  diet_catering_day, diet_consumption
  TO diet_writer_user;
