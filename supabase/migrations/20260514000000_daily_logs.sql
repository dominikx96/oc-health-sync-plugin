-- Per-day, manually-entered lifestyle facts. One row per local day.
-- Upsertable via the MCP `health_log_day` tool. Idempotent migration.

CREATE TABLE IF NOT EXISTS daily_logs (
  day         DATE        PRIMARY KEY,
  tz          TEXT        NOT NULL,
  alcohol     BOOLEAN,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Explicit grants. ALTER DEFAULT PRIVILEGES covers SELECT for read roles, but write
-- grants and the gym_writer_role write surface must be explicit.
GRANT SELECT                  ON daily_logs TO health_read_role;
GRANT INSERT, UPDATE, SELECT  ON daily_logs TO gym_writer_role;
-- The existing REVOKE on health_samples/device_state/summary_cache from gym_writer_role
-- in 20260511000100_gym_roles.sql stays in place — daily_logs is the only health-domain
-- table that gym_writer_role is allowed to write.
