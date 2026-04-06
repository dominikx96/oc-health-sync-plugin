import type { DatabaseSync } from 'node:sqlite';
import { createDatabase } from './connection.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS health_samples (
  uuid            TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL,
  sample_kind     TEXT NOT NULL CHECK(sample_kind IN ('quantity', 'category', 'workout')),
  data_type       TEXT NOT NULL,
  start_date      TEXT NOT NULL,
  end_date        TEXT NOT NULL,
  value           REAL,
  unit            TEXT,
  source_name     TEXT,
  source_bundle   TEXT,
  device_name     TEXT,
  device_model    TEXT,
  workout_duration_seconds    REAL,
  workout_total_energy_kcal   REAL,
  workout_total_distance_m    REAL,
  workout_activity_name       TEXT,
  metadata_json   TEXT DEFAULT '{}',
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at      TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_samples_type_date
  ON health_samples(data_type, start_date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_samples_kind_date
  ON health_samples(sample_kind, start_date) WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_samples_deleted
  ON health_samples(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS daily_summaries (
  date            TEXT PRIMARY KEY,
  device_id       TEXT NOT NULL,
  markdown        TEXT NOT NULL,
  generated_at    TEXT NOT NULL DEFAULT (datetime('now')),
  data_hash       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_metadata (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL,
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function initDatabase(dbPath: string): DatabaseSync {
  const db = createDatabase(dbPath);
  db.exec(SCHEMA_SQL);
  return db;
}
