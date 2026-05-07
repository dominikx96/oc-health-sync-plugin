import type { Pool } from '../db.js';

interface ColumnRow { table_name: string; column_name: string; data_type: string; }

export async function describeSchema(pool: Pool): Promise<string> {
  const cols = await pool.query<ColumnRow>(`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('health_samples', 'device_state', 'summary_cache')
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
    '```'
  ].join('\n');
}
