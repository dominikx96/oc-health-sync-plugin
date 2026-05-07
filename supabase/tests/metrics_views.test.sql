-- Insert deterministic samples and check the views aggregate them correctly.
TRUNCATE health_samples;

INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date, source_name)
VALUES
  ('a1', 'quantity', 'HKQuantityTypeIdentifierStepCount',     3000, 'count', '2026-04-01T08:00:00Z', '2026-04-01T08:30:00Z', 'iPhone'),
  ('a2', 'quantity', 'HKQuantityTypeIdentifierStepCount',     5000, 'count', '2026-04-01T18:00:00Z', '2026-04-01T18:30:00Z', 'iPhone'),
  ('a3', 'quantity', 'HKQuantityTypeIdentifierHeartRate',       70, 'count/min', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z', 'Watch'),
  ('a4', 'quantity', 'HKQuantityTypeIdentifierHeartRate',       80, 'count/min', '2026-04-01T11:00:00Z', '2026-04-01T11:00:00Z', 'Watch');

DO $$
DECLARE
  total_steps NUMERIC;
  avg_hr      NUMERIC;
BEGIN
  SELECT m.total_steps INTO total_steps
    FROM daily_metrics('UTC') m
   WHERE m.day = DATE '2026-04-01';
  IF total_steps IS DISTINCT FROM 8000 THEN
    RAISE EXCEPTION 'expected 8000 steps, got %', total_steps;
  END IF;

  SELECT m.avg_heart_rate INTO avg_hr
    FROM daily_metrics('UTC') m
   WHERE m.day = DATE '2026-04-01';
  IF round(avg_hr) IS DISTINCT FROM 75 THEN
    RAISE EXCEPTION 'expected avg HR 75, got %', avg_hr;
  END IF;

  RAISE NOTICE 'metrics_views.test.sql OK';
END $$;

TRUNCATE health_samples;
