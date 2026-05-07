TRUNCATE health_samples;

INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
VALUES
  ('c1', 'quantity', 'HKQuantityTypeIdentifierStepCount',     1, 'count', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z'),
  ('c2', 'quantity', 'HKQuantityTypeIdentifierStepCount',     1, 'count', '2026-04-03T10:00:00Z', '2026-04-03T10:00:00Z');

DO $$
DECLARE
  rec RECORD;
  found_gap BOOLEAN := false;
BEGIN
  FOR rec IN
    SELECT * FROM data_completeness(
      '2026-04-01T00:00:00Z'::timestamptz,
      '2026-04-04T00:00:00Z'::timestamptz,
      'UTC'
    )
  LOOP
    IF rec.day = DATE '2026-04-02' AND rec.data_type = 'HKQuantityTypeIdentifierStepCount' AND rec.sample_count = 0 THEN
      found_gap := true;
    END IF;
  END LOOP;
  IF NOT found_gap THEN
    RAISE EXCEPTION 'expected gap on 2026-04-02 for StepCount, but found none';
  END IF;
  RAISE NOTICE 'data_completeness.test.sql OK';
END $$;

TRUNCATE health_samples;
