import { Type } from '@sinclair/typebox';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { executeHealthQuery } from './query.js';
import { METRIC_MAP } from '../utils/constants.js';

const COMPARE_METRICS = [
  'steps',
  'active_energy',
  'distance',
  'flights_climbed',
  'basal_energy',
  'resting_hr',
  'hrv',
  'spo2',
  'respiratory_rate',
  'walking_speed',
  'sleep_duration',
];

interface PeriodResult {
  metric: string;
  value: number | null;
  unit: string;
}

function queryPeriod(
  db: DatabaseSync,
  from: string,
  to: string,
): PeriodResult[] {
  const results: PeriodResult[] = [];

  for (const metric of COMPARE_METRICS) {
    const def = METRIC_MAP[metric];
    const agg = def?.defaultAggregation ?? 'avg';
    const result = executeHealthQuery(db, { metric, from, to, aggregation: agg }) as Record<string, unknown>;
    results.push({
      metric,
      value: typeof result.value === 'number' ? result.value : null,
      unit: (result.unit as string) ?? def?.unit ?? '',
    });
  }

  return results;
}

export function executeComparison(
  db: DatabaseSync,
  params: {
    period_a_from: string;
    period_a_to: string;
    period_b_from: string;
    period_b_to: string;
    metrics?: string[];
  },
): object {
  const metricsToCompare = params.metrics ?? COMPARE_METRICS;

  const periodA = queryPeriod(db, params.period_a_from, params.period_a_to);
  const periodB = queryPeriod(db, params.period_b_from, params.period_b_to);

  const comparison = metricsToCompare.map((metric) => {
    const a = periodA.find((r) => r.metric === metric);
    const b = periodB.find((r) => r.metric === metric);

    const valA = a?.value ?? null;
    const valB = b?.value ?? null;

    let delta: number | null = null;
    let deltaPercent: number | null = null;
    if (valA !== null && valB !== null) {
      delta = Math.round((valB - valA) * 10) / 10;
      if (valA !== 0) {
        deltaPercent = Math.round(((valB - valA) / Math.abs(valA)) * 1000) / 10;
      }
    }

    return {
      metric,
      unit: a?.unit ?? b?.unit ?? '',
      period_a: valA,
      period_b: valB,
      delta,
      delta_percent: deltaPercent,
    };
  });

  return {
    period_a: { from: params.period_a_from, to: params.period_a_to },
    period_b: { from: params.period_b_from, to: params.period_b_to },
    comparison,
  };
}

export function registerCompareTool(
  api: PluginApi,
  db: DatabaseSync,
): void {
  api.registerTool({
    name: 'health_compare',
    description:
      'Compare health metrics between two time periods. Returns side-by-side values with deltas and percentage changes. Use for "compare this week vs last week" or "how did March compare to February?".',
    parameters: Type.Object({
      period_a_from: Type.String({ description: 'Period A start date (YYYY-MM-DD)' }),
      period_a_to: Type.String({ description: 'Period A end date (YYYY-MM-DD)' }),
      period_b_from: Type.String({ description: 'Period B start date (YYYY-MM-DD)' }),
      period_b_to: Type.String({ description: 'Period B end date (YYYY-MM-DD)' }),
      metrics: Type.Optional(
        Type.Array(Type.String(), {
          description: `Metrics to compare. Defaults to all. Available: ${COMPARE_METRICS.join(', ')}`,
        }),
      ),
    }),
    execute(_id, params) {
      const result = executeComparison(db, params as {
        period_a_from: string;
        period_a_to: string;
        period_b_from: string;
        period_b_to: string;
        metrics?: string[];
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  });
}
