-- Returns a set of detected anomalies in the trailing window_days days.
-- kind     : machine-readable identifier (sleep_deficit, hrv_decline, hr_spike, low_step_day)
-- severity : 'info' | 'warn' | 'alert'
-- detail   : human-readable description
-- ref_date : the date the anomaly is anchored to (for grouping/sorting)
CREATE OR REPLACE FUNCTION detect_anomalies(p_window_days INT)
RETURNS TABLE (
  kind     TEXT,
  severity TEXT,
  detail   TEXT,
  ref_date DATE
) LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_now    TIMESTAMPTZ := now();
  v_start  TIMESTAMPTZ := now() - (p_window_days || ' days')::interval;
BEGIN
  -- 1. Sleep deficit: 3 consecutive nights < 360 minutes
  RETURN QUERY
    WITH nightly AS (
      SELECT
        (start_date AT TIME ZONE 'UTC')::date AS night,
        SUM(EXTRACT(EPOCH FROM (end_date - start_date)) / 60) AS minutes
      FROM health_samples
      WHERE deleted_at IS NULL
        AND data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
        AND start_date >= v_start
      GROUP BY 1
    ),
    flagged AS (
      SELECT night, minutes,
             COUNT(*) FILTER (WHERE minutes < 360) OVER (
               ORDER BY night ROWS BETWEEN 2 PRECEDING AND CURRENT ROW
             ) AS deficit_run
      FROM nightly
    )
    SELECT 'sleep_deficit'::TEXT,
           'warn'::TEXT,
           ('3 consecutive nights of <6h sleep ending ' || night)::TEXT,
           night
    FROM flagged WHERE deficit_run = 3;

  -- 2. HRV decline: 7-day mean < 0.85 * 30-day mean
  RETURN QUERY
    WITH daily_hrv AS (
      SELECT (start_date AT TIME ZONE 'UTC')::date AS day,
             AVG(value) AS hrv
      FROM health_samples
      WHERE deleted_at IS NULL
        AND data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN'
        AND start_date >= v_now - INTERVAL '30 days'
      GROUP BY 1
    ),
    avgs AS (
      SELECT
        AVG(hrv) FILTER (WHERE day >= (v_now - INTERVAL '7 days')::date)  AS recent,
        AVG(hrv)                                                          AS baseline,
        MAX(day)                                                          AS latest_day
      FROM daily_hrv
    )
    SELECT 'hrv_decline'::TEXT,
           'alert'::TEXT,
           ('7d HRV ' || ROUND(recent::numeric, 1) || ' is ' ||
             ROUND((100 * (1 - recent / baseline))::numeric, 1) ||
             '% below 30d baseline ' || ROUND(baseline::numeric, 1))::TEXT,
           latest_day
    FROM avgs
    WHERE recent IS NOT NULL AND baseline IS NOT NULL AND recent < 0.85 * baseline;

  -- 3. Resting HR spike: any day in window with rHR > 14d baseline + 5
  RETURN QUERY
    WITH daily_rhr AS (
      SELECT (start_date AT TIME ZONE 'UTC')::date AS day,
             AVG(value) AS rhr
      FROM health_samples
      WHERE deleted_at IS NULL
        AND data_type = 'HKQuantityTypeIdentifierRestingHeartRate'
        AND start_date >= v_now - INTERVAL '14 days'
      GROUP BY 1
    ),
    baseline AS (SELECT AVG(rhr) AS rhr FROM daily_rhr)
    SELECT 'hr_spike'::TEXT,
           'warn'::TEXT,
           ('Resting HR ' || ROUND(d.rhr::numeric, 0) || ' on ' || d.day ||
             ' (>5 bpm above 14d baseline ' || ROUND(b.rhr::numeric, 0) || ')')::TEXT,
           d.day
    FROM daily_rhr d, baseline b
    WHERE d.day >= v_start::date
      AND d.rhr > b.rhr + 5;

  -- 4. Low-step day: any day in window with steps < 3000
  -- NOTE: GROUP BY date only (not start_date) so all step samples on the same
  -- calendar day are aggregated together before comparing against the threshold.
  RETURN QUERY
    SELECT 'low_step_day'::TEXT,
           'info'::TEXT,
           ('Only ' || ROUND(SUM(value)::numeric, 0) || ' steps on ' ||
             (start_date AT TIME ZONE 'UTC')::date)::TEXT,
           (start_date AT TIME ZONE 'UTC')::date
    FROM health_samples
    WHERE deleted_at IS NULL
      AND data_type = 'HKQuantityTypeIdentifierStepCount'
      AND start_date >= v_start
    GROUP BY (start_date AT TIME ZONE 'UTC')::date
    HAVING SUM(value) < 3000;

END $$;

GRANT EXECUTE ON FUNCTION detect_anomalies(INT) TO health_read_role, health_ingest_role;
