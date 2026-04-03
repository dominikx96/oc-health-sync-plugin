import { Type } from '@sinclair/typebox';
import type Database from 'better-sqlite3';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import {
  getDailyMetricValues,
  getSleepDurationForDate,
  getLastSampleDate,
  getWorkoutTotalForRange,
  getAvgMetricForRange,
} from '../db/queries.js';

function formatDate(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

interface Anomaly {
  severity: 'warning' | 'info' | 'ok';
  title: string;
  detail: string;
}

function detectTrend(
  db: Database.Database,
  dataType: string,
  label: string,
  unit: string,
  days: number,
  consecutiveThreshold: number,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const from = formatDate(days);
  const to = formatDate(0);
  const values = getDailyMetricValues(db, dataType, from, to);

  if (values.length < consecutiveThreshold) return anomalies;

  // Check for consecutive decline
  let declineCount = 0;
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i].value < values[i - 1].value) {
      declineCount++;
    } else {
      break;
    }
  }

  if (declineCount >= consecutiveThreshold) {
    const recent = values.slice(-consecutiveThreshold - 1);
    const trend = recent.map((v) => `${v.value} ${unit}`).join(' → ');
    anomalies.push({
      severity: 'warning',
      title: `${label} declining trend`,
      detail: `${declineCount + 1} consecutive days of decline (${trend})`,
    });
  }

  // Check for consecutive increase
  let increaseCount = 0;
  for (let i = values.length - 1; i > 0; i--) {
    if (values[i].value > values[i - 1].value) {
      increaseCount++;
    } else {
      break;
    }
  }

  if (increaseCount >= consecutiveThreshold) {
    const recent = values.slice(-consecutiveThreshold - 1);
    const trend = recent.map((v) => `${v.value} ${unit}`).join(' → ');
    anomalies.push({
      severity: 'warning',
      title: `${label} rising trend`,
      detail: `${increaseCount + 1} consecutive days of increase (${trend})`,
    });
  }

  return anomalies;
}

function detectDeviation(
  db: Database.Database,
  dataType: string,
  label: string,
  unit: string,
  days: number,
  threshold: number,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const sevenDaysAgo = formatDate(7);
  const fourteenDaysAgo = formatDate(days);
  const today = formatDate(0);

  const avg7d = getAvgMetricForRange(db, dataType, sevenDaysAgo, today);
  const avg14d = getAvgMetricForRange(db, dataType, fourteenDaysAgo, today);

  if (avg7d === null || avg14d === null || avg14d === 0) return anomalies;

  const pctDiff = ((avg7d - avg14d) / avg14d) * 100;

  if (Math.abs(pctDiff) > threshold) {
    const direction = pctDiff > 0 ? 'above' : 'below';
    anomalies.push({
      severity: 'warning',
      title: `${label} deviation`,
      detail: `7-day avg ${avg7d} ${unit} is ${Math.abs(pctDiff).toFixed(1)}% ${direction} ${days}-day avg ${avg14d} ${unit}`,
    });
  }

  return anomalies;
}

function detectSleepDeficit(
  db: Database.Database,
  thresholdMinutes: number,
): Anomaly[] {
  const dates = dateRange(formatDate(7), formatDate(1));
  let belowCount = 0;
  let totalMinutes = 0;

  for (const d of dates) {
    const dur = getSleepDurationForDate(db, d);
    totalMinutes += dur;
    if (dur > 0 && dur < thresholdMinutes) belowCount++;
  }

  if (belowCount >= 3) {
    const avgMinutes = dates.length > 0 ? totalMinutes / dates.length : 0;
    const avgH = Math.floor(avgMinutes / 60);
    const avgM = Math.round(avgMinutes % 60);
    return [
      {
        severity: 'warning',
        title: 'Sleep duration below average',
        detail: `${belowCount} of last 7 nights below ${thresholdMinutes / 60}h. Average ${avgH}h ${avgM}m.`,
      },
    ];
  }

  return [];
}

function detectMissingData(db: Database.Database): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const expectedTypes = [
    { type: 'HKQuantityTypeIdentifierHeartRate', label: 'Heart rate' },
    { type: 'HKQuantityTypeIdentifierStepCount', label: 'Steps' },
    {
      type: 'HKCategoryTypeIdentifierSleepAnalysis',
      label: 'Sleep analysis',
    },
  ];

  const twoDaysAgo = formatDate(2);

  for (const { type, label } of expectedTypes) {
    const lastDate = getLastSampleDate(db, type);
    if (!lastDate || lastDate < twoDaysAgo) {
      anomalies.push({
        severity: 'info',
        title: `Missing ${label} data`,
        detail: lastDate
          ? `Last sample: ${lastDate}`
          : 'No samples found',
      });
    }
  }

  return anomalies;
}

function detectWorkoutSpike(db: Database.Database): Anomaly[] {
  const thisWeekFrom = formatDate(7);
  const thisWeekTo = formatDate(0);
  const thisWeekTotal = getWorkoutTotalForRange(db, thisWeekFrom, thisWeekTo);

  if (thisWeekTotal === 0) return [];

  // Compare to 4-week average
  const fourWeeksFrom = formatDate(28);
  const fourWeeksTo = formatDate(8);
  const fourWeeksTotal = getWorkoutTotalForRange(
    db,
    fourWeeksFrom,
    fourWeeksTo,
  );
  const weeklyAvg = fourWeeksTotal / 3; // 3 weeks of comparison

  if (weeklyAvg === 0) return [];

  const ratio = thisWeekTotal / weeklyAvg;
  if (ratio > 1.5) {
    const thisH = Math.round(thisWeekTotal / 3600);
    const avgH = Math.round(weeklyAvg / 3600);
    return [
      {
        severity: 'warning',
        title: 'Workout volume spike',
        detail: `This week: ~${thisH}h vs 4-week avg ~${avgH}h (${Math.round(ratio * 100)}%)`,
      },
    ];
  }

  return [];
}

export function registerAnomaliesTool(
  api: PluginApi,
  db: Database.Database,
): void {
  api.registerTool({
    name: 'health_anomalies',
    description:
      'Detect notable patterns and anomalies in recent health data. Checks for HR/HRV trends, metric deviations, sleep deficits, missing data, and workout spikes. Use for "anything unusual?" or "how is my recovery?"',
    parameters: Type.Object({
      days: Type.Optional(
        Type.Number({
          description: 'Lookback window in days (default: 14)',
          default: 14,
        }),
      ),
      sensitivity: Type.Optional(
        Type.Union([
          Type.Literal('low'),
          Type.Literal('medium'),
          Type.Literal('high'),
        ]),
      ),
    }),
    execute(_id, params) {
      const { days = 14, sensitivity = 'medium' } = params as {
        days?: number;
        sensitivity?: string;
      };

      const consecutiveThreshold = sensitivity === 'high' ? 2 : sensitivity === 'low' ? 4 : 3;
      const deviationThreshold = sensitivity === 'high' ? 5 : sensitivity === 'low' ? 15 : 10;
      const sleepThreshold = sensitivity === 'high' ? 7.5 * 60 : sensitivity === 'low' ? 6 * 60 : 7 * 60;

      const anomalies: Anomaly[] = [];

      // HR/HRV trends
      anomalies.push(
        ...detectTrend(
          db,
          'HKQuantityTypeIdentifierRestingHeartRate',
          'Resting HR',
          'bpm',
          days,
          consecutiveThreshold,
        ),
      );
      anomalies.push(
        ...detectTrend(
          db,
          'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
          'HRV',
          'ms',
          days,
          consecutiveThreshold,
        ),
      );

      // Metric deviations
      anomalies.push(
        ...detectDeviation(
          db,
          'HKQuantityTypeIdentifierRestingHeartRate',
          'Resting HR',
          'bpm',
          days,
          deviationThreshold,
        ),
      );
      anomalies.push(
        ...detectDeviation(
          db,
          'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
          'HRV',
          'ms',
          days,
          deviationThreshold,
        ),
      );

      // Sleep deficit
      anomalies.push(...detectSleepDeficit(db, sleepThreshold));

      // Missing data
      anomalies.push(...detectMissingData(db));

      // Workout spike
      anomalies.push(...detectWorkoutSpike(db));

      if (anomalies.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `## Anomalies Check (last ${days} days)\n\n✅ No notable anomalies detected. All metrics within normal ranges.`,
            },
          ],
        };
      }

      const lines = [`## Anomalies Detected (last ${days} days)\n`];
      for (const a of anomalies) {
        const icon =
          a.severity === 'warning'
            ? '⚠️'
            : a.severity === 'info'
              ? 'ℹ️'
              : '✅';
        lines.push(`${icon} **${a.title}**: ${a.detail}\n`);
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  });
}
