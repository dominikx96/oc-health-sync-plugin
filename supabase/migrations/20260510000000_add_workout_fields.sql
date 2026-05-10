-- Workout-specific columns. Previously the iOS payload's workout fields were
-- silently dropped by Zod's strip-unknown default; now they live in dedicated
-- columns so queries like "all cycling workouts in the last 6 months" are easy.
ALTER TABLE health_samples
  ADD COLUMN IF NOT EXISTS workout_activity_type_id INTEGER,
  ADD COLUMN IF NOT EXISTS workout_activity_name    TEXT,
  ADD COLUMN IF NOT EXISTS workout_duration_seconds DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS workout_energy_kcal      DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS workout_distance_m       DOUBLE PRECISION;

-- Partial index on (activity_type_id, start_date) restricted to live workout rows.
-- Apple may add new HKWorkoutActivityType ids over time, so no CHECK constraint.
CREATE INDEX IF NOT EXISTS idx_workouts_type_start
  ON health_samples (workout_activity_type_id, start_date)
  WHERE deleted_at IS NULL AND sample_kind = 'workout';
