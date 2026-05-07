-- Per-day aggregated metrics, tz-aware.
-- Returns one row per day in the date range covered by samples.
CREATE OR REPLACE FUNCTION daily_metrics(p_tz TEXT)
RETURNS TABLE (
  day                DATE,
  total_steps        NUMERIC,
  avg_heart_rate     NUMERIC,
  resting_heart_rate NUMERIC,
  hrv_mean           NUMERIC,
  sleep_minutes      NUMERIC,
  workout_count      INTEGER
) LANGUAGE sql STABLE AS $$
  WITH bucketed AS (
    SELECT
      (start_date AT TIME ZONE p_tz)::date AS day,
      data_type,
      value,
      sample_kind,
      end_date - start_date AS duration
    FROM health_samples
    WHERE deleted_at IS NULL
  )
  SELECT
    day,
    SUM(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierStepCount')                              AS total_steps,
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRate')                              AS avg_heart_rate,
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierRestingHeartRate')                       AS resting_heart_rate,
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN')               AS hrv_mean,
    SUM(EXTRACT(EPOCH FROM duration) / 60) FILTER (WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis') AS sleep_minutes,
    COUNT(*) FILTER (WHERE sample_kind = 'workout')::int                                                   AS workout_count
  FROM bucketed
  GROUP BY day
  ORDER BY day;
$$;

CREATE OR REPLACE FUNCTION weekly_metrics(p_tz TEXT)
RETURNS TABLE (
  week_start         DATE,
  total_steps        NUMERIC,
  avg_heart_rate     NUMERIC,
  resting_heart_rate NUMERIC,
  hrv_mean           NUMERIC,
  sleep_minutes      NUMERIC,
  workout_count      INTEGER
) LANGUAGE sql STABLE AS $$
  WITH bucketed AS (
    SELECT
      date_trunc('week', start_date AT TIME ZONE p_tz)::date AS week_start,
      data_type,
      value,
      sample_kind,
      end_date - start_date AS duration
    FROM health_samples
    WHERE deleted_at IS NULL
  )
  SELECT
    week_start,
    SUM(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierStepCount'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRate'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierRestingHeartRate'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN'),
    SUM(EXTRACT(EPOCH FROM duration) / 60) FILTER (WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'),
    COUNT(*) FILTER (WHERE sample_kind = 'workout')::int
  FROM bucketed
  GROUP BY week_start
  ORDER BY week_start;
$$;

CREATE OR REPLACE FUNCTION monthly_metrics(p_tz TEXT)
RETURNS TABLE (
  month_start        DATE,
  total_steps        NUMERIC,
  avg_heart_rate     NUMERIC,
  resting_heart_rate NUMERIC,
  hrv_mean           NUMERIC,
  sleep_minutes      NUMERIC,
  workout_count      INTEGER
) LANGUAGE sql STABLE AS $$
  WITH bucketed AS (
    SELECT
      date_trunc('month', start_date AT TIME ZONE p_tz)::date AS month_start,
      data_type,
      value,
      sample_kind,
      end_date - start_date AS duration
    FROM health_samples
    WHERE deleted_at IS NULL
  )
  SELECT
    month_start,
    SUM(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierStepCount'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRate'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierRestingHeartRate'),
    AVG(value) FILTER (WHERE data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN'),
    SUM(EXTRACT(EPOCH FROM duration) / 60) FILTER (WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'),
    COUNT(*) FILTER (WHERE sample_kind = 'workout')::int
  FROM bucketed
  GROUP BY month_start
  ORDER BY month_start;
$$;

GRANT EXECUTE ON FUNCTION daily_metrics(TEXT)   TO health_read_role, health_ingest_role;
GRANT EXECUTE ON FUNCTION weekly_metrics(TEXT)  TO health_read_role, health_ingest_role;
GRANT EXECUTE ON FUNCTION monthly_metrics(TEXT) TO health_read_role, health_ingest_role;
