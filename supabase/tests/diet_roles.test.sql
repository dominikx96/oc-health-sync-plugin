DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'diet_writer_role') THEN
    RAISE EXCEPTION 'diet_writer_role missing';
  END IF;

  -- diet_writer_role writes diet tables
  IF NOT has_table_privilege('diet_writer_role', 'public.diet_consumption', 'INSERT') THEN
    RAISE EXCEPTION 'diet_writer_role missing INSERT on diet_consumption';
  END IF;
  IF NOT has_table_privilege('diet_writer_role', 'public.diet_catering_meals', 'UPDATE') THEN
    RAISE EXCEPTION 'diet_writer_role missing UPDATE on diet_catering_meals';
  END IF;

  -- diet_add_note(scope='day') writes to daily_logs via diet writer pool
  IF NOT has_table_privilege('diet_writer_role', 'public.daily_logs', 'INSERT') THEN
    RAISE EXCEPTION 'diet_writer_role missing INSERT on daily_logs (needed by diet_add_note scope=day)';
  END IF;
  IF NOT has_table_privilege('diet_writer_role', 'public.daily_logs', 'UPDATE') THEN
    RAISE EXCEPTION 'diet_writer_role missing UPDATE on daily_logs';
  END IF;

  -- diet_writer_role cannot touch other domains' write surfaces
  IF has_table_privilege('diet_writer_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'diet_writer_role should NOT write health_samples';
  END IF;
  IF has_table_privilege('diet_writer_role', 'public.training_sets', 'INSERT') THEN
    RAISE EXCEPTION 'diet_writer_role should NOT write training_sets';
  END IF;

  -- other writers cannot touch diet_*
  IF has_table_privilege('gym_writer_role', 'public.diet_consumption', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role should NOT write diet_consumption';
  END IF;
  IF has_table_privilege('health_ingest_role', 'public.diet_products', 'INSERT') THEN
    RAISE EXCEPTION 'health_ingest_role should NOT write diet_products';
  END IF;

  -- defense-in-depth: REVOKE ALL must override the ALTER DEFAULT PRIVILEGES
  -- SELECT that health_ingest_role would otherwise inherit on new tables.
  IF has_table_privilege('health_ingest_role', 'public.diet_products', 'SELECT') THEN
    RAISE EXCEPTION 'health_ingest_role should NOT have SELECT on diet_products (REVOKE ALL must strip inherited default-privilege SELECT)';
  END IF;

  -- read role can SELECT diet_* (functions are added in Task 3, not checked here)
  IF NOT has_table_privilege('health_read_role', 'public.diet_catering_meals', 'SELECT') THEN
    RAISE EXCEPTION 'health_read_role missing SELECT on diet_catering_meals';
  END IF;
  IF has_table_privilege('health_read_role', 'public.diet_consumption', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role should NOT write diet_consumption';
  END IF;

  RAISE NOTICE 'diet_roles.test.sql OK';
END $$;
