-- For each (day, data_type) pair in the requested range, returns the sample count.
-- Days with zero samples for an expected data_type appear as sample_count = 0.
CREATE OR REPLACE FUNCTION data_completeness(
  p_start TIMESTAMPTZ,
  p_end   TIMESTAMPTZ,
  p_tz    TEXT
) RETURNS TABLE (
  day          DATE,
  data_type    TEXT,
  sample_count BIGINT
) LANGUAGE sql STABLE AS $$
  WITH days AS (
    SELECT generate_series(
      (p_start AT TIME ZONE p_tz)::date,
      (p_end   AT TIME ZONE p_tz)::date,
      INTERVAL '1 day'
    )::date AS day
  ),
  expected_types AS (
    SELECT unnest(ARRAY[
      'HKQuantityTypeIdentifierStepCount',
      'HKQuantityTypeIdentifierHeartRate',
      'HKQuantityTypeIdentifierRestingHeartRate',
      'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
      'HKCategoryTypeIdentifierSleepAnalysis'
    ]) AS data_type
  ),
  grid AS (
    SELECT d.day, t.data_type
    FROM days d CROSS JOIN expected_types t
  ),
  counts AS (
    SELECT
      (start_date AT TIME ZONE p_tz)::date AS day,
      data_type,
      COUNT(*) AS sample_count
    FROM health_samples
    WHERE deleted_at IS NULL
      AND start_date >= p_start
      AND start_date <  p_end
    GROUP BY (start_date AT TIME ZONE p_tz)::date, data_type
  )
  SELECT g.day, g.data_type, COALESCE(c.sample_count, 0) AS sample_count
  FROM grid g
  LEFT JOIN counts c USING (day, data_type)
  ORDER BY g.day, g.data_type;
$$;

GRANT EXECUTE ON FUNCTION data_completeness(TIMESTAMPTZ, TIMESTAMPTZ, TEXT)
  TO health_read_role, health_ingest_role;
