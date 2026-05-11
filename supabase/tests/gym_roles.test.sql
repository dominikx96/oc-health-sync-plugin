DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gym_writer_role') THEN
    RAISE EXCEPTION 'gym_writer_role missing';
  END IF;

  IF NOT has_table_privilege('gym_writer_role', 'public.training_sets', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role missing INSERT on training_sets';
  END IF;

  IF has_table_privilege('gym_writer_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role should NOT have INSERT on health_samples';
  END IF;
  IF has_table_privilege('gym_writer_role', 'public.health_samples', 'SELECT') THEN
    RAISE EXCEPTION 'gym_writer_role should NOT have SELECT on health_samples';
  END IF;
  IF has_table_privilege('gym_writer_role', 'public.device_state', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role should NOT have INSERT on device_state';
  END IF;
  IF has_table_privilege('gym_writer_role', 'public.summary_cache', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role should NOT have INSERT on summary_cache';
  END IF;

  IF NOT has_table_privilege('health_read_role', 'public.training_sessions', 'SELECT') THEN
    RAISE EXCEPTION 'health_read_role missing SELECT on training_sessions';
  END IF;
  IF has_table_privilege('health_read_role', 'public.training_sessions', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role should NOT have INSERT on training_sessions';
  END IF;

  RAISE NOTICE 'gym_roles.test.sql OK';
END $$;
