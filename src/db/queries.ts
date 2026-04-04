import type Database from 'better-sqlite3';

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
  metadata_json, updated_at, deleted_at
)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), NULL)
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
  metadata_json = excluded.metadata_json,
  updated_at = datetime('now'),
  deleted_at = NULL;
`;

export function upsertSamples(
  db: Database.Database,
  deviceId: string,
  samples: IngestSample[],
): number {
  const stmt = db.prepare(UPSERT_SQL);

  const runAll = db.transaction((items: IngestSample[]) => {
    let count = 0;
    for (const s of items) {
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
        metadataJson,
      );
      count++;
    }
    return count;
  });

  return runAll(samples);
}

export function softDeleteSamples(
  db: Database.Database,
  uuids: string[],
): number {
  if (uuids.length === 0) return 0;

  const placeholders = uuids.map(() => '?').join(', ');
  const stmt = db.prepare(`
    UPDATE health_samples
    SET deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE uuid IN (${placeholders}) AND deleted_at IS NULL
  `);

  return stmt.run(...uuids).changes;
}

export function getSampleCount(db: Database.Database): number {
  const row = db.prepare(
    'SELECT COUNT(*) as count FROM health_samples WHERE deleted_at IS NULL',
  ).get() as { count: number } | undefined;
  return row?.count ?? 0;
}

export function getLastIngestTime(db: Database.Database): string | null {
  const row = db.prepare(
    "SELECT value FROM sync_metadata WHERE key = 'last_ingest_at'",
  ).get() as { value: string } | undefined;
  return row?.value ?? null;
}

export function setSyncMetadata(
  db: Database.Database,
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
  db: Database.Database,
  key: string,
): string | null {
  const row = db.prepare(
    'SELECT value FROM sync_metadata WHERE key = ?',
  ).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function getSamplesInRange(
  db: Database.Database,
  dataType: string,
  from: string,
  to: string,
  limit = 100,
): HealthSampleRow[] {
  return db.prepare(`
    SELECT * FROM health_samples
    WHERE data_type = ?
      AND start_date >= ?
      AND start_date < datetime(?, '+1 day')
      AND deleted_at IS NULL
    ORDER BY start_date
    LIMIT ?
  `).all(dataType, from, to, limit) as HealthSampleRow[];
}

export function getAggregation(
  db: Database.Database,
  dataType: string,
  from: string,
  to: string,
  agg: 'avg' | 'sum' | 'min' | 'max' | 'latest',
): { value: number | null; count: number } {
  if (agg === 'latest') {
    const row = db.prepare(`
      SELECT value, 1 as count FROM health_samples
      WHERE data_type = ?
        AND date(start_date) >= ?
        AND date(start_date) <= ?
        AND deleted_at IS NULL
      ORDER BY start_date DESC LIMIT 1
    `).get(dataType, from, to) as { value: number | null; count: number } | undefined;
    return row ?? { value: null, count: 0 };
  }

  const aggFn = agg.toUpperCase();
  const row = db.prepare(`
    SELECT ${aggFn}(value) as value, COUNT(*) as count
    FROM health_samples
    WHERE data_type = ?
      AND date(start_date) >= ?
      AND date(start_date) <= ?
      AND deleted_at IS NULL
  `).get(dataType, from, to) as { value: number | null; count: number } | undefined;
  return row ?? { value: null, count: 0 };
}

export function getDailyBreakdown(
  db: Database.Database,
  dataType: string,
  from: string,
  to: string,
  agg: 'avg' | 'sum' | 'min' | 'max',
): Array<{ date: string; value: number | null }> {
  const aggFn = agg.toUpperCase();
  return db.prepare(`
    SELECT date(start_date) as date, ${aggFn}(value) as value
    FROM health_samples
    WHERE data_type = ?
      AND date(start_date) >= ?
      AND date(start_date) <= ?
      AND deleted_at IS NULL
    GROUP BY date(start_date)
    ORDER BY date(start_date)
  `).all(dataType, from, to) as Array<{ date: string; value: number | null }>;
}

export interface SleepStageRow {
  stage: number;
  minutes: number;
}

export function getSleepStages(
  db: Database.Database,
  date: string,
): SleepStageRow[] {
  return db.prepare(`
    SELECT
      value as stage,
      SUM((julianday(end_date) - julianday(start_date)) * 24 * 60) as minutes
    FROM health_samples
    WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
      AND datetime(start_date) >= datetime(?, '+18 hours')
      AND datetime(start_date) < datetime(?, '+1 day', '+18 hours')
      AND deleted_at IS NULL
    GROUP BY value
  `).all(date, date) as SleepStageRow[];
}

export function getSleepWindow(
  db: Database.Database,
  date: string,
): { sleep_start: string | null; sleep_end: string | null } {
  const row = db.prepare(`
    SELECT
      MIN(start_date) as sleep_start,
      MAX(end_date) as sleep_end
    FROM health_samples
    WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
      AND datetime(start_date) >= datetime(?, '+18 hours')
      AND datetime(start_date) < datetime(?, '+1 day', '+18 hours')
      AND value NOT IN (0, 2)
      AND deleted_at IS NULL
  `).get(date, date) as { sleep_start: string | null; sleep_end: string | null } | undefined;
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
  db: Database.Database,
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
      AND date(start_date) = ?
      AND deleted_at IS NULL
    ORDER BY start_date
  `).all(date) as WorkoutRow[];
}

export function getStepsForDate(
  db: Database.Database,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(value), 0) as total
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierStepCount'
      AND date(start_date) = ?
      AND deleted_at IS NULL
  `).get(date) as { total: number };
  return row.total;
}

export function getActiveEnergyForDate(
  db: Database.Database,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(value), 0) as total
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierActiveEnergyBurned'
      AND date(start_date) = ?
      AND deleted_at IS NULL
  `).get(date) as { total: number };
  return row.total;
}

export function getDistanceForDate(
  db: Database.Database,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(value), 0) as total
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierDistanceWalkingRunning'
      AND date(start_date) = ?
      AND deleted_at IS NULL
  `).get(date) as { total: number };
  return row.total;
}

export function getHeartRateStats(
  db: Database.Database,
  date: string,
): { avg_hr: number | null; min_hr: number | null; max_hr: number | null; count: number } {
  const row = db.prepare(`
    SELECT
      ROUND(AVG(value), 1) as avg_hr,
      MIN(value) as min_hr,
      MAX(value) as max_hr,
      COUNT(*) as count
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierHeartRate'
      AND date(start_date) = ?
      AND deleted_at IS NULL
  `).get(date) as { avg_hr: number | null; min_hr: number | null; max_hr: number | null; count: number };
  return row;
}

export function getLatestMetricForDate(
  db: Database.Database,
  dataType: string,
  date: string,
): number | null {
  const row = db.prepare(`
    SELECT value FROM health_samples
    WHERE data_type = ?
      AND date(start_date) = ?
      AND deleted_at IS NULL
    ORDER BY start_date DESC LIMIT 1
  `).get(dataType, date) as { value: number | null } | undefined;
  return row?.value ?? null;
}

export function getAvgMetricForRange(
  db: Database.Database,
  dataType: string,
  from: string,
  to: string,
): number | null {
  const row = db.prepare(`
    SELECT ROUND(AVG(value), 1) as avg_val
    FROM health_samples
    WHERE data_type = ?
      AND date(start_date) >= ?
      AND date(start_date) <= ?
      AND deleted_at IS NULL
  `).get(dataType, from, to) as { avg_val: number | null } | undefined;
  return row?.avg_val ?? null;
}

export function getLatestWeightUpTo(
  db: Database.Database,
  date: string,
): { value: number; unit: string; date: string } | null {
  const row = db.prepare(`
    SELECT value, unit, date(start_date) as date
    FROM health_samples
    WHERE data_type = 'HKQuantityTypeIdentifierBodyMass'
      AND date(start_date) <= ?
      AND deleted_at IS NULL
    ORDER BY start_date DESC LIMIT 1
  `).get(date) as { value: number; unit: string; date: string } | undefined;
  return row ?? null;
}

export function getDataHash(
  db: Database.Database,
  date: string,
): string {
  const row = db.prepare(`
    SELECT COUNT(*) || '-' || COALESCE(MAX(updated_at), '') as hash
    FROM health_samples
    WHERE date(start_date) = ?
      AND deleted_at IS NULL
  `).get(date) as { hash: string };
  return row.hash;
}

export function getCachedSummary(
  db: Database.Database,
  date: string,
): { markdown: string; data_hash: string; generated_at: string } | null {
  const row = db.prepare(`
    SELECT markdown, data_hash, generated_at
    FROM daily_summaries
    WHERE date = ?
  `).get(date) as { markdown: string; data_hash: string; generated_at: string } | undefined;
  return row ?? null;
}

export function setCachedSummary(
  db: Database.Database,
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
  db: Database.Database,
  dates: string[],
): void {
  if (dates.length === 0) return;
  const placeholders = dates.map(() => '?').join(', ');
  db.prepare(`DELETE FROM daily_summaries WHERE date IN (${placeholders})`).run(
    ...dates,
  );
}

export function getDailyMetricValues(
  db: Database.Database,
  dataType: string,
  from: string,
  to: string,
): Array<{ date: string; value: number }> {
  return db.prepare(`
    SELECT date(start_date) as date, value
    FROM health_samples
    WHERE data_type = ?
      AND date(start_date) >= ?
      AND date(start_date) <= ?
      AND deleted_at IS NULL
    ORDER BY start_date
  `).all(dataType, from, to) as Array<{ date: string; value: number }>;
}

export function getSleepDurationForDate(
  db: Database.Database,
  date: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(
      (julianday(end_date) - julianday(start_date)) * 24 * 60
    ), 0) as minutes
    FROM health_samples
    WHERE data_type = 'HKCategoryTypeIdentifierSleepAnalysis'
      AND datetime(start_date) >= datetime(?, '+18 hours')
      AND datetime(start_date) < datetime(?, '+1 day', '+18 hours')
      AND value NOT IN (0, 2)
      AND deleted_at IS NULL
  `).get(date, date) as { minutes: number };
  return row.minutes;
}

export function getLastSampleDate(
  db: Database.Database,
  dataType: string,
): string | null {
  const row = db.prepare(`
    SELECT date(start_date) as last_date
    FROM health_samples
    WHERE data_type = ?
      AND deleted_at IS NULL
    ORDER BY start_date DESC LIMIT 1
  `).get(dataType) as { last_date: string } | undefined;
  return row?.last_date ?? null;
}

export function getWorkoutTotalForRange(
  db: Database.Database,
  from: string,
  to: string,
): number {
  const row = db.prepare(`
    SELECT COALESCE(SUM(workout_duration_seconds), 0) as total
    FROM health_samples
    WHERE sample_kind = 'workout'
      AND date(start_date) >= ?
      AND date(start_date) <= ?
      AND deleted_at IS NULL
  `).get(from, to) as { total: number };
  return row.total;
}
