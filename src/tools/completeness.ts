import { Type } from '@sinclair/typebox';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { getLastSampleDate } from '../db/queries.js';
import { METRIC_MAP } from '../utils/constants.js';
import { dateRange } from '../utils/dates.js';

interface MetricCompleteness {
  metric: string;
  data_type: string;
  unit: string;
  last_sample_date: string | null;
  days_with_data: number;
  total_days: number;
  coverage_pct: number;
  total_samples: number;
  avg_samples_per_day: number;
}

function getMetricCompleteness(
  db: DatabaseSync,
  metric: string,
  dataType: string,
  unit: string,
  from: string,
  to: string,
  totalDays: number,
): MetricCompleteness {
  const lastDate = getLastSampleDate(db, dataType);

  const row = db.prepare(`
    SELECT
      COUNT(DISTINCT local_date) as days_with_data,
      COUNT(*) as total_samples
    FROM health_samples
    WHERE data_type = ?
      AND local_date >= ?
      AND local_date <= ?
      AND deleted_at IS NULL
  `).get(dataType, from, to) as unknown as { days_with_data: number; total_samples: number };

  const daysWithData = row.days_with_data;
  const totalSamples = row.total_samples;
  const coveragePct = totalDays > 0 ? Math.round((daysWithData / totalDays) * 100) : 0;
  const avgSamplesPerDay = daysWithData > 0 ? Math.round((totalSamples / daysWithData) * 10) / 10 : 0;

  return {
    metric,
    data_type: dataType,
    unit,
    last_sample_date: lastDate,
    days_with_data: daysWithData,
    total_days: totalDays,
    coverage_pct: coveragePct,
    total_samples: totalSamples,
    avg_samples_per_day: avgSamplesPerDay,
  };
}

export function executeCompletenessReport(
  db: DatabaseSync,
  params: { from: string; to: string; metrics?: string[] },
): object {
  const { from, to, metrics: requestedMetrics } = params;
  const dates = dateRange(from, to);
  const totalDays = dates.length;

  if (totalDays === 0) {
    return { error: 'Invalid date range' };
  }

  // Also check sleep and workouts
  const allMetrics: Array<{ key: string; dataType: string; unit: string }> = [];

  const metricKeys = requestedMetrics ?? Object.keys(METRIC_MAP);
  for (const key of metricKeys) {
    const def = METRIC_MAP[key];
    if (def) {
      allMetrics.push({ key, dataType: def.dataType, unit: def.unit });
    }
  }

  // Always include sleep and workouts unless specific metrics were requested
  if (!requestedMetrics) {
    allMetrics.push(
      { key: 'sleep_analysis', dataType: 'HKCategoryTypeIdentifierSleepAnalysis', unit: 'category' },
      { key: 'workouts', dataType: 'HKWorkoutTypeIdentifier', unit: 'workout' },
    );
  }

  const results: MetricCompleteness[] = allMetrics.map(({ key, dataType, unit }) =>
    getMetricCompleteness(db, key, dataType, unit, from, to, totalDays),
  );

  // Overall stats
  const withData = results.filter((r) => r.days_with_data > 0);
  const withoutData = results.filter((r) => r.days_with_data === 0);
  const avgCoverage = results.length > 0
    ? Math.round(results.reduce((sum, r) => sum + r.coverage_pct, 0) / results.length)
    : 0;

  // Find gap days — dates with no data for any metric
  const gapRow = db.prepare(`
    SELECT local_date as d, COUNT(*) as cnt
    FROM health_samples
    WHERE local_date >= ?
      AND local_date <= ?
      AND deleted_at IS NULL
    GROUP BY local_date
  `).all(from, to) as unknown as Array<{ d: string; cnt: number }>;

  const datesWithAnyData = new Set(gapRow.map((r) => r.d));
  const gapDays = dates.filter((d) => !datesWithAnyData.has(d));

  return {
    from,
    to,
    total_days: totalDays,
    overall: {
      metrics_tracked: withData.length,
      metrics_missing: withoutData.length,
      avg_coverage_pct: avgCoverage,
      gap_days: gapDays,
      gap_day_count: gapDays.length,
    },
    metrics: results,
  };
}

export function registerCompletenessTool(
  api: PluginApi,
  db: DatabaseSync,
): void {
  api.registerTool({
    name: 'health_completeness',
    description:
      'Report on data completeness for health metrics over a date range. Shows which metrics have data, coverage percentages, sample counts, and identifies gap days with no data. Use for "is my data complete?", "any gaps in my tracking?", or "what metrics am I missing?"',
    parameters: Type.Object({
      from: Type.String({ description: 'Start date (YYYY-MM-DD)' }),
      to: Type.String({ description: 'End date (YYYY-MM-DD)' }),
      metrics: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Specific metrics to check. If omitted, checks all known metrics plus sleep and workouts.',
        }),
      ),
    }),
    execute(_id, params) {
      const result = executeCompletenessReport(db, params as { from: string; to: string; metrics?: string[] });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  });
}
