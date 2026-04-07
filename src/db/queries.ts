import type { DatabaseSync } from 'node:sqlite';

export interface HealthSampleRow {
  uuid: string;
  device_id: string;
  sample_kind: 'quantity' | 'category' | 'workout';
  data_type: string;
  start_date: string;
  end_date: string;
  value: number | null;
  unit: string | null;
  source_name: string | null;
  source_bundle: string | null;
  device_name: string | null;
  device_model: string | null;
  workout_duration_seconds: number | null;
  workout_total_energy_kcal: number | null;
  workout_total_distance_m: number | null;
  workout_activity_name: string | null;
  metadata_json: string;
}

export interface IngestSample {
  uuid: string;
  sample_kind: 'quantity' | 'category' | 'workout';
  data_type: string;
  start_date: string;
  end_date: string;
  value?: number | null;
  unit?: string | null;
  source_name?: string | null;
  source_bundle?: string | null;
  device_name?: string | null;
  device_model?: string | null;
  workout_duration?: number | null;
  workout_energy?: number | null;
  workout_distance?: number | null;
  workout_activity_name?: string | null;
  metadata?: Record<string, unknown>;
  events?: unknown[];
  activities?: unknown[];
}

const UPSERT_SQL = `
INSERT INTO health_samples (
  uuid, device_id, sample_kind, data_type,
  start_date, end_date, value, unit,
  source_name, source_bundle, device_name, device_model,
  workout_duration_seconds, workout_total_energy_kcal,
  workout_total_distance_m, workout_activity_name,
  local_date, metadata_json, updated_at, deleted_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
ON CONFLICT(uuid) DO UPDATE SET
  value = excluded.value,
  unit = excluded.unit,
  start_date = excluded.start_date,
  end_date = excluded.end_date,
  source_name = excluded.source_name,
  source_bundle = excluded.source_bundle,
  device_name = excluded.device_name,
  device_model = excluded.device_model,
  workout_duration_seconds = excluded.workout_duration_seconds,
  workout_total_energy_kcal = excluded.workout_total_energy_kcal,
  workout_total_distance_m = excluded.workout_total_distance_m,
  workout_activity_name = excluded.workout_activity_name,
  local_date = excluded.local_date,
  metadata_json = excluded.metadata_json,
  updated_at = datetime('now'),
  deleted_at = NULL;
`;

export function upsertSamples(
  db: DatabaseSync,
  deviceId: string,
  samples: Array<IngestSample & { local_date: string }>,
): number {
  const stmt = db.prepare(UPSERT_SQL);
  let count = 0;

  db.exec('BEGIN');
  try {
    for (const s of samples) {
      const metadataJson = JSON.stringify({
        ...(s.metadata ?? {}),
        ...(s.events ? { events: s.events } : {}),
        ...(s.activities ? { activities: s.activities } : {}),
      });

      stmt.run(
        s.uuid,
        deviceId,
        s.sample_kind,
        s.data_type,
        s.start_date,
        s.end_date,
        s.value ?? null,
        s.unit ?? null,
        s.source_name ?? null,
        s.source_bundle ?? null,
        s.device_name ?? null,
        s.device_model ?? null,
        s.workout_duration ?? null,
        s.workout_energy ?? null,
        s.workout_distance ?? null,
        s.workout_activity_name ?? null,
        s.local_date,
        metadataJson,
      );
      count++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return count;
}

export function softDeleteSamples(
  db: DatabaseSync,
  uuids: string[],
): number {
  if (uuids.length === 0) return 0;

  const placeholders = uuids.map(() => '?').join(', ');
  const stmt = db.prepare(`
    UPDATE health_samples
    SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE uuid IN (${placeholders}) AND deleted_at IS NULL
  `);

  return Number(stmt.run(...uuids).changes);
}

export function getSampleCount(db: DatabaseSync): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM health_samples WHERE deleted_at IS NULL',
  ).get() as unknown as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getLastIngestTime(db: DatabaseSync): string | null {
  const row = db.prepare(
    "SELECT value FROM sync_metadata WHERE key = 'last_ingest_at'",
  ).get() as unknown as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSyncMetadata(
  db: DatabaseSync,
  key: string,
  value: string,
): void {
  db.prepare(`
    INSERT INTO sync_metadata (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, value);
}

export function getSyncMetadata(
  db: DatabaseSync,
  key: string,
): string | null {
  const row = db.prepare(
    'SELECT value FROM sync_metadata WHERE key = ?',
  ).get(key) as unknown as { value: string } | undefined;
  return row?.value ?? null;
}

export function getSamplesInRange(
  db: DatabaseSync,
  dataType: string,
  from: string,
  to: string,
  limit = 100,
): HealthSampleRow[] {
  return db.prepare(`
    SELECT * FROM health_samples
    WHERE data_type = ?
      AND local_date >= ?
      AND local_date <= ?
      AND deleted_at IS NULL
    ORDER BY start_date
    LIMIT ?
  `).all(dataType, from, to, limit) as unknown as HealthSampleRow[];
}

export function getAggregation(
  db: DatabaseSync,
  dataType: string,
  from: string,
  to: string,
  agg: 'avg' | 'sum' | 'min' | 'max' | 'latest',
): { value: number | null; count: number } {
  if (agg === 'latest') {
    const row = db.prepare(`
      SELECT value, 1 as count FROM health_samples
      WHERE data_type = ?
        AND local_date >= ?
        AND local_date <= ?
        AND deleted_at IS NULL
      ORDER BY start_date DESC LIMIT 1
    `).get(dataType, from, to) as unknown as { value: number | null; count: number } | undefined;
    return row ?? { value: null, count: 0 };
  }

  const aggFn = agg.toUpperCase();
  const row = db.prepare(`
    SELECT ${aggFn}(value) as value, COUNT(*) as count
    FROM health_samples
    WHERE data_type = ?
      AND local_date >= ?
      AND local_date <= ?
      AND deleted_at IS NULL
  `).get(dataType, from, to) as unknown as { value: number | null; count: number } | undefined;
  return row ?? { value: null, count: 0 };
}

export function getDailyBreakdown(
  db: DatabaseSync,
  dataType: string,
  from: string,
  to: string,
  agg: 'avg' | 'sum' | 'min' | 'max',
): Array<{ date: string; value: number | null }> {
  const aggFn = agg.toUpperCase();
  return db.prepare(`
    SELECT local_date as date, ${aggFn}(value) as value
    FROM health_samples
    WHERE data_type = ?
      AND local_date >= ?
      AND local_date <= ?
      AND deleted_at IS NULL
    GROUP BY local_date
    ORDER BY local_date
  `).all(dataType, from, to) as unknown as Array<{ date: string; value: number | null }>;
}

export interface SleepStageRow {
  stage: number;
  minutes: number;
}

export function getSleepStages(
  db: DatabaseSync,
  date: string,
  sleepStartUtc: string,
  sleepEndUtc: string,
): SleepStageRow[] {
  return db.prepare(`
    SELECT
      value as stage,
      SUM((julianday(end_date) - julianday(start_date)) * 24 * 60) as minutes
    FROM health_samples
    WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
      AND datetime(start_date) >= datetime(?)
      AND datetime(start_date) < datetime(?)
      AND deleted_at IS NULL
    GROUP BY value
  `).all(sleepStartUtc, sleepEndUtc) as unknown as SleepStageRow[];
}

export function getSleepWindow(
  db: DatabaseSync,
  date: string,
  sleepStartUtc: string,
  sleepEndUtc: string,
): { sleep_start: string | null; sleep_end: string | null } {
  const row = db.prepare(`
    SELECT
      MIN(start_date) as sleep_start,
      MAX(end_date) as sleep_end
    FROM health_samples
    WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
      AND datetime(start_date) >= datetime(?)
      AND datetime(start_date) < datetime(?)
      AND value NOT IN (0, 2)
      AND deleted_at IS NULL
  `).get(sleepStartUtc, sleepEndUtc) as unknown as { sleep_start: string | null; sleep_end: string | null } | undefined;
  return row ?? { sleep_start: null, sleep_end: null };
}

export interface WorkoutRow {
  workout_activity_name: string | null;
  workout_duration_seconds: number | null;
  workout_total_energy_kcal: number | null;
  workout_total_distance_m: number | null;
  start_date: string;
  end_date: string;
}

export function getWorkouts(
  db: DatabaseSync,
  date: string,
): WorkoutRow[] {
  return db.prepare(`
    SELECT
      workout_activity_name,
      workout_duration_seconds,
      workout_total_energy_kcal,
      workout_total_distance_m,
      start_date,
      end_date
    FROM health_samples
    WHERE sample_kind = 'workout'
      AND local_date = ?
      AND deleted_at IS NULL
    ORDER BY start_date
  `).all(date) as unknown as WorkoutRow[];
}

export function getStepsForDate(
  db: DatabaseSync,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(value), 0) as total
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierStepCount'
      AND local_date = ?
      AND deleted_at IS NULL
  `).get(date) as unknown as { total: number };
  return row.total;
}

export function getActiveEnergyForDate(
  db: DatabaseSync,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(value), 0) as total
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierActiveEnergyBurned'
      AND local_date = ?
      AND deleted_at IS NULL
  `).get(date) as unknown as { total: number };
  return row.total;
}

export function getDistanceForDate(
  db: DatabaseSync,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(value), 0) as total
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierDistanceWalkingRunning'
      AND local_date = ?
      AND deleted_at IS NULL
  `).get(date) as unknown as { total: number };
  return row.total;
}

export function getLatestMetricForDate(
  db: DatabaseSync,
  dataType: string,
  date: string,
): number | null {
  const row = db.prepare(`
    SELECT value FROM health_samples
    WHERE data_type = ?
      AND local_date = ?
      AND deleted_at IS NULL
    ORDER BY start_date DESC LIMIT 1
  `).get(dataType, date) as unknown as { value: number | null } | undefined;
  return row?.value ?? null;
}

export function getAvgMetricForRange(
  db: DatabaseSync,
  dataType: string,
  from: string,
  to: string,
): number | null {
  const row = db.prepare(`
    SELECT ROUND(AVG(value), 1) as avg_val
    FROM health_samples
    WHERE data_type = ?
      AND local_date >= ?
      AND local_date <= ?
      AND deleted_at IS NULL
  `).get(dataType, from, to) as unknown as { avg_val: number | null } | undefined;
  return row?.avg_val ?? null;
}

export function getLatestWeightUpTo(
  db: DatabaseSync,
  date: string,
): { value: number; unit: string; date: string } | null {
  const row = db.prepare(`
    SELECT value, unit, local_date as date
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierBodyMass'
      AND local_date <= ?
      AND deleted_at IS NULL
    ORDER BY start_date DESC LIMIT 1
  `).get(date) as unknown as { value: number; unit: string; date: string } | undefined;
  return row ?? null;
}

export function getDataHash(
  db: DatabaseSync,
  date: string,
): string {
  const row = db.prepare(`
    SELECT COUNT(*) || '-' || COALESCE(MAX(updated_at), '') as hash
    FROM health_samples
    WHERE local_date = ?
      AND deleted_at IS NULL
  `).get(date) as unknown as { hash: string };
  return row.hash;
}

export function getCachedSummary(
  db: DatabaseSync,
  date: string,
): { markdown: string; data_hash: string; generated_at: string } | null {
  const row = db.prepare(`
    SELECT markdown, data_hash, generated_at
    FROM daily_summaries
    WHERE date = ?
  `).get(date) as unknown as { markdown: string; data_hash: string; generated_at: string } | undefined;
  return row ?? null;
}

export function setCachedSummary(
  db: DatabaseSync,
  date: string,
  deviceId: string,
  markdown: string,
  dataHash: string,
): void {
  db.prepare(`
    INSERT INTO daily_summaries (date, device_id, markdown, generated_at, data_hash)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(date) DO UPDATE SET
      markdown = excluded.markdown,
      generated_at = datetime('now'),
      data_hash = excluded.data_hash
  `).run(date, deviceId, markdown, dataHash);
}

export function invalidateSummariesForDates(
  db: DatabaseSync,
  dates: string[],
): void {
  if (dates.length === 0) return;
  const placeholders = dates.map(() => '?').join(', ');
  db.prepare(`DELETE FROM daily_summaries WHERE date IN (${placeholders})`).run(
    ...dates,
  );
}

export function getDailyMetricValues(
  db: DatabaseSync,
  dataType: string,
  from: string,
  to: string,
): Array<{ date: string; value: number }> {
  return db.prepare(`
    SELECT local_date as date, value
    FROM health_samples
    WHERE data_type = ?
      AND local_date >= ?
      AND local_date <= ?
      AND deleted_at IS NULL
    ORDER BY start_date
  `).all(dataType, from, to) as unknown as Array<{ date: string; value: number }>;
}

export function getSleepDurationForDate(
  db: DatabaseSync,
  date: string,
  sleepStartUtc: string,
  sleepEndUtc: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      (julianday(end_date) - julianday(start_date)) * 24 * 60
    ), 0) as minutes
    FROM health_samples
    WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
      AND datetime(start_date) >= datetime(?)
      AND datetime(start_date) < datetime(?)
      AND value NOT IN (0, 2)
      AND deleted_at IS NULL
  `).get(sleepStartUtc, sleepEndUtc) as unknown as { minutes: number };
  return row.minutes;
}

export function getLastSampleDate(
  db: DatabaseSync,
  dataType: string,
): string | null {
  const row = db.prepare(`
    SELECT local_date as last_date
    FROM health_samples
    WHERE data_type = ?
      AND deleted_at IS NULL
    ORDER BY start_date DESC LIMIT 1
  `).get(dataType) as unknown as { last_date: string } | undefined;
  return row?.last_date ?? null;
}

export function getWorkoutTotalForRange(
  db: DatabaseSync,
  from: string,
  to: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(workout_duration_seconds), 0) as total
    FROM health_samples
    WHERE sample_kind = 'workout'
      AND local_date >= ?
      AND local_date <= ?
      AND deleted_at IS NULL
  `).get(from, to) as unknown as { total: number };
  return row.total;
}
