-- Health samples: one row per HealthKit sample, soft-deleted via deleted_at.
CREATE TABLE health_samples (
  id           BIGSERIAL PRIMARY KEY,
  uuid         TEXT NOT NULL UNIQUE,
  sample_kind  TEXT NOT NULL CHECK (sample_kind IN ('quantity', 'category', 'workout')),
  data_type    TEXT NOT NULL,
  value        DOUBLE PRECISION,
  unit         TEXT,
  start_date   TIMESTAMPTZ NOT NULL,
  end_date     TIMESTAMPTZ NOT NULL,
  source_name  TEXT,
  metadata     JSONB,
  device_id    TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ
);

CREATE INDEX idx_samples_data_type_start
  ON health_samples (data_type, start_date)
  WHERE deleted_at IS NULL;

CREATE INDEX idx_samples_start_date
  ON health_samples (start_date)
  WHERE deleted_at IS NULL;

-- Device sync state: one row per device that has ever uploaded.
CREATE TABLE device_state (
  device_id      TEXT PRIMARY KEY,
  last_anchor    TEXT,
  last_synced_at TIMESTAMPTZ,
  metadata       JSONB
);

-- Cache of rendered markdown summaries.
-- cache_key formats (all dates ISO-8601 YYYY-MM-DD):
--   daily:<date>:<tz>
--   weekly:<monday-of-week>:<tz>
--   monthly:YYYY-MM:<tz>
CREATE TABLE summary_cache (
  cache_key    TEXT PRIMARY KEY,
  markdown     TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  invalidated  BOOLEAN NOT NULL DEFAULT false
);
