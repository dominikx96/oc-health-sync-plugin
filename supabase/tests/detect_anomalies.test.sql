TRUNCATE health_samples;

-- Seed: 30 days of healthy data, then 3 nights of bad sleep at the end.
INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
SELECT
  'sleep-' || i,
  'category',
  'HKCategoryTypeIdentifierSleepAnalysis',
  1,
  NULL,
  ('2026-04-01T22:00:00Z'::timestamptz + (i || ' days')::interval),
  ('2026-04-02T05:00:00Z'::timestamptz + (i || ' days')::interval)
FROM generate_series(0, 29) i;

-- Last 3 nights only 4 hours.
UPDATE health_samples
   SET end_date = start_date + INTERVAL '4 hours'
 WHERE uuid IN ('sleep-27', 'sleep-28', 'sleep-29');

DO $$
DECLARE
  found BOOLEAN := false;
  rec   RECORD;
BEGIN
  FOR rec IN SELECT * FROM detect_anomalies(40) LOOP
    IF rec.kind = 'sleep_deficit' THEN
      found := true;
    END IF;
  END LOOP;
  IF NOT found THEN
    RAISE EXCEPTION 'expected sleep_deficit anomaly, got none';
  END IF;
  RAISE NOTICE 'detect_anomalies.test.sql OK';
END $$;

TRUNCATE health_samples;
