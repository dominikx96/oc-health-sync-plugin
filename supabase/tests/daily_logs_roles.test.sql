DO $$
BEGIN
  -- gym_writer_role can write daily_logs.
  IF NOT has_table_privilege('gym_writer_role', 'public.daily_logs', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role missing INSERT on daily_logs';
  END IF;
  IF NOT has_table_privilege('gym_writer_role', 'public.daily_logs', 'UPDATE') THEN
    RAISE EXCEPTION 'gym_writer_role missing UPDATE on daily_logs';
  END IF;
  IF NOT has_table_privilege('gym_writer_role', 'public.daily_logs', 'SELECT') THEN
    RAISE EXCEPTION 'gym_writer_role missing SELECT on daily_logs';
  END IF;

  -- health_read_role can only SELECT.
  IF NOT has_table_privilege('health_read_role', 'public.daily_logs', 'SELECT') THEN
    RAISE EXCEPTION 'health_read_role missing SELECT on daily_logs';
  END IF;
  IF has_table_privilege('health_read_role', 'public.daily_logs', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role should NOT have INSERT on daily_logs';
  END IF;
  IF has_table_privilege('health_read_role', 'public.daily_logs', 'UPDATE') THEN
    RAISE EXCEPTION 'health_read_role should NOT have UPDATE on daily_logs';
  END IF;
  IF has_table_privilege('health_read_role', 'public.daily_logs', 'DELETE') THEN
    RAISE EXCEPTION 'health_read_role should NOT have DELETE on daily_logs';
  END IF;

  -- Existing REVOKE on health tables must still hold (regression).
  IF has_table_privilege('gym_writer_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role regressed: now has INSERT on health_samples';
  END IF;
  IF has_table_privilege('gym_writer_role', 'public.device_state', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role regressed: now has INSERT on device_state';
  END IF;
  IF has_table_privilege('gym_writer_role', 'public.summary_cache', 'INSERT') THEN
    RAISE EXCEPTION 'gym_writer_role regressed: now has INSERT on summary_cache';
  END IF;

  RAISE NOTICE 'daily_logs_roles.test.sql OK';
END $$;
