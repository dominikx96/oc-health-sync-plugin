import type { Pool } from '../db.js';
import { WORKOUT_ACTIVITY_TYPES } from '../constants/workout-activity-types.js';

interface ColumnRow { table_name: string; column_name: string; data_type: string; }

export async function describeSchema(pool: Pool): Promise<string> {
  const cols = await pool.query<ColumnRow>(`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('health_samples','device_state','summary_cache','daily_logs',
                   'exercises','gyms','gym_machines',
                   'training_sessions','training_exercises','training_sets')
     ORDER BY table_name, ordinal_position
  `);

  const byTable: Record<string, ColumnRow[]> = {};
  for (const c of cols.rows) {
    (byTable[c.table_name] ??= []).push(c);
  }

  const tableSection = Object.entries(byTable).map(([name, rows]) =>
    [
      `### ${name}`,
      '',
      '| column | type |',
      '|---|---|',
      ...rows.map((r) => `| \`${r.column_name}\` | ${r.data_type} |`),
      ''
    ].join('\n')
  ).join('\n');

  const workoutTypesSection = [
    '## Workout activity types',
    '',
    'Mapping of `workout_activity_type_id` (Apple `HKWorkoutActivityType` raw value) to its canonical name.',
    'Use the id when filtering `health_samples` rows where `sample_kind = \'workout\'`.',
    '',
    '| id | name |',
    '|---|---|',
    ...WORKOUT_ACTIVITY_TYPES.map((w) => `| ${w.id} | \`${w.name}\` |`),
    ''
  ].join('\n');

  return [
    '# oc-health-sync database',
    '',
    'You can query this database via the `run_sql` tool. The role is read-only on data tables.',
    '',
    '## Tables',
    '',
    tableSection,
    '## Set-returning functions',
    '',
    '- `daily_metrics(tz TEXT)` — per-day aggregations. Columns: `day`, `total_steps`, `avg_heart_rate`, `resting_heart_rate`, `hrv_mean`, `sleep_minutes`, `workout_count`.',
    '- `weekly_metrics(tz TEXT)` — same shape, weekly buckets. Bucket column is `week_start`.',
    '- `monthly_metrics(tz TEXT)` — same shape, monthly buckets. Bucket column is `month_start`.',
    '- `data_completeness(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ, p_tz TEXT)` — per-day counts by `data_type` with gaps as 0.',
    '- `detect_anomalies(p_window_days INT)` — returns rows of `{ kind, severity, detail, ref_date }`. Severity is one of `info`, `warn`, `alert`.',
    '',
    workoutTypesSection,
    '## Example queries',
    '',
    '```sql',
    '-- last 7 days of step counts',
    "SELECT day, total_steps FROM daily_metrics('UTC') ORDER BY day DESC LIMIT 7;",
    '',
    '-- heart-rate distribution last week',
    "SELECT date_trunc('hour', start_date) AS hour, AVG(value) FROM health_samples",
    " WHERE deleted_at IS NULL AND data_type = 'HKQuantityTypeIdentifierHeartRate'",
    "   AND start_date >= now() - INTERVAL '7 days'",
    ' GROUP BY 1 ORDER BY 1;',
    '',
    '-- all cycling workouts in the last 6 months',
    'SELECT start_date, workout_duration_seconds, workout_distance_m, workout_energy_kcal',
    '  FROM health_samples',
    ' WHERE deleted_at IS NULL',
    "   AND sample_kind = 'workout'",
    '   AND workout_activity_type_id = 13',
    "   AND start_date >= now() - INTERVAL '6 months'",
    ' ORDER BY start_date DESC;',
    '```',
    '',
    '## Gym helpers',
    '',
    "- `last_sessions_by_type(p_type TEXT, p_gym_id BIGINT)` — up to 2 rows: most-recent same-gym session of the given type, then most-recent other-gym session. Columns: session_id, gym_id, gym_slug, same_gym, started_at, ended_at, rating, total_sets, total_volume_kg, top_set (jsonb).",
    "- `last_exercise_results(p_exercise_id BIGINT, p_current_gym_id BIGINT)` — same shape for a specific exercise. `sets` is a JSONB array of `{set_index, reps, weight_kg, rpe, is_warmup, without_break, notes}`.",
    "- View `current_open_session` — exactly the open session row (or empty).",
    '',
    '## Gym example queries',
    '',
    '```sql',
    '-- most recent push session at a gym',
    "SELECT * FROM last_sessions_by_type('push', (SELECT id FROM gyms WHERE slug='fitfabric-wola'));",
    '',
    '-- weekly volume across all sessions',
    "SELECT date_trunc('week', s.started_at)::date AS week,",
    '       COALESCE(SUM(ts.weight_kg * ts.reps), 0) AS volume_kg',
    '  FROM training_sessions s',
    '  JOIN training_exercises te ON te.session_id = s.id AND te.deleted_at IS NULL',
    '  JOIN training_sets ts      ON ts.training_exercise_id = te.id AND ts.deleted_at IS NULL',
    ' WHERE s.deleted_at IS NULL AND s.ended_at IS NOT NULL',
    ' GROUP BY 1 ORDER BY 1 DESC;',
    '',
    '-- cross-domain: average session rating vs HRV the prior night',
    "SELECT s.rating,",
    "       AVG(hs.value) FILTER (WHERE hs.data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN')",
    '  FROM training_sessions s',
    "  LEFT JOIN health_samples hs ON hs.deleted_at IS NULL",
    "   AND hs.start_date >= s.started_at - INTERVAL '24 hours'",
    "   AND hs.start_date <  s.started_at",
    ' WHERE s.deleted_at IS NULL AND s.rating IS NOT NULL',
    ' GROUP BY s.rating ORDER BY s.rating;',
    '```',
    '',
    '## Daily lifestyle log',
    '',
    '`daily_logs` — one row per local day. `day` is the local date in `tz`. `alcohol` is `NULL` until logged, then `true` / `false`. `notes` is last-write-wins. Upsert via the `health_log_day` MCP tool; `run_sql` is read-only on this table.',
    '',
    '## Training-set continuity',
    '',
    '`training_sets.without_break = true` marks a set performed immediately after the previous one with no rest (drop set, rest-pause, "one more"). Default `false`. Combine with decreasing `weight_kg` in a query to identify drop sets specifically.',
    '',
    '## Daily-log example queries',
    '',
    '```sql',
    '-- alcohol days in the last 30, with HRV the next morning',
    'SELECT dl.day, dl.alcohol,',
    "       AVG(hs.value) FILTER (WHERE hs.data_type = 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN') AS hrv_next_morning",
    '  FROM daily_logs dl',
    "  LEFT JOIN health_samples hs ON hs.deleted_at IS NULL",
    "   AND (hs.start_date AT TIME ZONE dl.tz)::date = dl.day + INTERVAL '1 day'",
    " WHERE dl.day >= current_date - INTERVAL '30 days'",
    ' GROUP BY dl.day, dl.alcohol',
    ' ORDER BY dl.day DESC;',
    '```'
  ].join('\n');
}
