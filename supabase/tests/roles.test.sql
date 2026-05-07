DO $$
BEGIN
  PERFORM 1 FROM pg_roles WHERE rolname = 'health_ingest_role';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_ingest_role missing'; END IF;

  PERFORM 1 FROM pg_roles WHERE rolname = 'health_read_role';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_read_role missing'; END IF;

  -- read role must NOT have INSERT on health_samples
  IF has_table_privilege('health_read_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role should not have INSERT on health_samples';
  END IF;

  -- read role MUST have SELECT on health_samples
  IF NOT has_table_privilege('health_read_role', 'public.health_samples', 'SELECT') THEN
    RAISE EXCEPTION 'health_read_role missing SELECT on health_samples';
  END IF;

  -- read role MUST have INSERT/UPDATE on summary_cache
  IF NOT has_table_privilege('health_read_role', 'public.summary_cache', 'INSERT') THEN
    RAISE EXCEPTION 'health_read_role missing INSERT on summary_cache';
  END IF;
  IF NOT has_table_privilege('health_read_role', 'public.summary_cache', 'UPDATE') THEN
    RAISE EXCEPTION 'health_read_role missing UPDATE on summary_cache';
  END IF;

  -- ingest role MUST have INSERT on health_samples
  IF NOT has_table_privilege('health_ingest_role', 'public.health_samples', 'INSERT') THEN
    RAISE EXCEPTION 'health_ingest_role missing INSERT on health_samples';
  END IF;

  RAISE NOTICE 'roles.test.sql OK';
END $$;
