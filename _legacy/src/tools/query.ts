import { Type } from '@sinclair/typebox';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import {
  getAggregation,
  getDailyBreakdown,
  getSleepDurationForDate,
} from '../db/queries.js';
import { METRIC_MAP } from '../utils/constants.js';
import { dateRange } from '../utils/dates.js';
import { localTimeToUtc, nextDay } from '../utils/timezone.js';

const METRIC_KEYS = Object.keys(METRIC_MAP);

export function executeHealthQuery(
  db: DatabaseSync,
  params: { metric: string; from: string; to: string; aggregation?: string; timezone?: string },
): object {
  const { metric, from, to, aggregation, timezone } = params;
  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Special case: sleep_duration
  if (metric === 'sleep_duration') {
    const dates = dateRange(from, to);

    if (aggregation === 'daily_breakdown') {
      const days = dates.map((d) => {
        const ssUtc = localTimeToUtc(d, 18, tz);
        const seUtc = localTimeToUtc(nextDay(d), 18, tz);
        return { date: d, value: Math.round(getSleepDurationForDate(db, d, ssUtc, seUtc)) };
      });
      return { metric: 'sleep_duration', from, to, aggregation: 'daily_breakdown', days, unit: 'minutes' };
    }

    const totalMinutes = dates.reduce((sum, d) => {
      const ssUtc = localTimeToUtc(d, 18, tz);
      const seUtc = localTimeToUtc(nextDay(d), 18, tz);
      return sum + getSleepDurationForDate(db, d, ssUtc, seUtc);
    }, 0);
    const avgMinutes = dates.length > 0 ? totalMinutes / dates.length : 0;
    const agg = aggregation ?? 'avg';
    const value = agg === 'sum' ? totalMinutes : Math.round(avgMinutes);
    return { metric: 'sleep_duration', from, to, aggregation: agg, value, unit: 'minutes', data_points: dates.length };
  }

  const def = METRIC_MAP[metric];
  if (!def) {
    return { error: `Unknown metric "${metric}". Available: ${METRIC_KEYS.join(', ')}, sleep_duration` };
  }

  const agg = aggregation ?? def.defaultAggregation;

  if (agg === 'daily_breakdown') {
    const perDayAgg = def.perDay ?? 'avg';
    const dbAgg = perDayAgg === 'latest' ? 'max' : perDayAgg;
    const days = getDailyBreakdown(db, def.dataType, from, to, dbAgg as 'avg' | 'sum' | 'min' | 'max');
    return { metric, from, to, aggregation: agg, days, unit: def.unit };
  }

  if (agg !== 'avg' && agg !== 'sum' && agg !== 'min' && agg !== 'max' && agg !== 'latest') {
    return { error: `Invalid aggregation "${agg}". Use: avg, sum, min, max, latest, daily_breakdown` };
  }

  const result = getAggregation(db, def.dataType, from, to, agg);
  return {
    metric, from, to, aggregation: agg,
    value: result.value !== null ? Math.round(result.value * 10) / 10 : null,
    unit: def.unit,
    data_points: result.count,
  };
}

export function registerQueryTool(
  api: PluginApi,
  db: DatabaseSync,
  timezone?: string,
): void {
  api.registerTool({
    name: 'health_query',
    description:
      `Query a specific health metric with aggregation. Available metrics: ${METRIC_KEYS.join(', ')}, sleep_duration. Aggregations: avg, sum, min, max, latest, daily_breakdown.`,
    parameters: Type.Object({
      metric: Type.String({
        description: `Metric to query. One of: ${METRIC_KEYS.join(', ')}, sleep_duration`,
      }),
      from: Type.String({ description: 'Start date (YYYY-MM-DD)' }),
      to: Type.String({ description: 'End date (YYYY-MM-DD)' }),
      aggregation: Type.Optional(
        Type.Union([
          Type.Literal('avg'),
          Type.Literal('sum'),
          Type.Literal('min'),
          Type.Literal('max'),
          Type.Literal('latest'),
          Type.Literal('daily_breakdown'),
        ]),
      ),
    }),
    execute(_id, params) {
      const result = executeHealthQuery(db, { ...params as { metric: string; from: string; to: string; aggregation?: string }, timezone });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  });
}
