-- Verify daily_logs schema shape and upsert semantics.
TRUNCATE daily_logs;

DO $$
DECLARE
  rec RECORD;
BEGIN
  -- Column shape via information_schema.
  SELECT is_nullable, data_type INTO rec
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'daily_logs' AND column_name = 'alcohol';
  IF rec.is_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION 'expected alcohol to be nullable, got is_nullable=%', rec.is_nullable;
  END IF;
  IF rec.data_type IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'expected alcohol boolean, got %', rec.data_type;
  END IF;

  SELECT is_nullable INTO rec
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'daily_logs' AND column_name = 'tz';
  IF rec.is_nullable IS DISTINCT FROM 'NO' THEN
    RAISE EXCEPTION 'expected tz NOT NULL, got is_nullable=%', rec.is_nullable;
  END IF;

  -- Primary key on (day).
  PERFORM 1 FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema, table_name)
   WHERE tc.table_schema = 'public' AND tc.table_name = 'daily_logs'
     AND tc.constraint_type = 'PRIMARY KEY' AND kcu.column_name = 'day';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'expected PRIMARY KEY on daily_logs(day)';
  END IF;

  -- Upsert sanity: same day twice updates rather than duplicating.
  INSERT INTO daily_logs (day, tz, alcohol, notes)
    VALUES ('2026-05-14', 'Europe/Warsaw', true, 'pierwszy wpis');
  INSERT INTO daily_logs (day, tz, alcohol, notes)
    VALUES ('2026-05-14', 'Europe/Warsaw', false, 'drugi wpis')
    ON CONFLICT (day) DO UPDATE
       SET alcohol = EXCLUDED.alcohol, notes = EXCLUDED.notes, updated_at = now();

  IF (SELECT COUNT(*) FROM daily_logs WHERE day = '2026-05-14') <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 row after upsert';
  END IF;
  IF (SELECT alcohol FROM daily_logs WHERE day = '2026-05-14') IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'expected alcohol=false after upsert';
  END IF;

  RAISE NOTICE 'daily_logs_schema.test.sql OK';
END $$;

TRUNCATE daily_logs;
