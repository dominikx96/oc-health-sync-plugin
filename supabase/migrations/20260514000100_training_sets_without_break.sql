-- Mark a set as performed without rest before it (drop set / rest-pause / "one more").
-- Defaulted false so existing rows (and the previous MCP image) stay valid.

ALTER TABLE training_sets
  ADD COLUMN IF NOT EXISTS without_break BOOLEAN NOT NULL DEFAULT false;
