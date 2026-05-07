-- Verifies the three expected tables exist with the right columns.
DO $$
BEGIN
  -- health_samples
  PERFORM 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'health_samples';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_samples missing'; END IF;

  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'health_samples'
     AND column_name = 'uuid' AND is_nullable = 'NO';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_samples.uuid missing or nullable'; END IF;

  PERFORM 1 FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'health_samples'
     AND column_name = 'deleted_at';
  IF NOT FOUND THEN RAISE EXCEPTION 'health_samples.deleted_at missing'; END IF;

  -- device_state
  PERFORM 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'device_state';
  IF NOT FOUND THEN RAISE EXCEPTION 'device_state missing'; END IF;

  -- summary_cache
  PERFORM 1 FROM information_schema.tables
   WHERE table_schema = 'public' AND table_name = 'summary_cache';
  IF NOT FOUND THEN RAISE EXCEPTION 'summary_cache missing'; END IF;

  -- partial index on health_samples
  PERFORM 1 FROM pg_indexes
   WHERE schemaname = 'public'
     AND tablename = 'health_samples'
     AND indexname = 'idx_samples_data_type_start';
  IF NOT FOUND THEN RAISE EXCEPTION 'idx_samples_data_type_start missing'; END IF;

  RAISE NOTICE 'schema.test.sql OK';
END $$;
