import { Type } from '@sinclair/typebox';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import {
  getDailyMetricValues,
  getSleepDurationForDate,
  getLastSampleDate,
  getWorkoutTotalForRange,
  getAvgMetricForRange,
} from '../db/queries.js';
import { daysAgo, dateRange } from '../utils/dates.js';
import { localTimeToUtc, nextDay } from '../utils/timezone.js';

interface Anomaly {
  severity: 'warning' | 'info' | 'ok';
  title: string;
  detail: string;
}

function detectTrend(
  db: DatabaseSync,
  dataType: string,
  label: string,
  unit: string,
  days: number,
  consecutiveThreshold: number,
  timezone?: string,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const from = daysAgo(days, timezone);
  const to = daysAgo(0, timezone);
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
  db: DatabaseSync,
  dataType: string,
  label: string,
  unit: string,
  days: number,
  threshold: number,
  timezone?: string,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const sevenDaysAgo = daysAgo(7, timezone);
  const fourteenDaysAgo = daysAgo(days, timezone);
  const today = daysAgo(0, timezone);

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
  db: DatabaseSync,
  thresholdMinutes: number,
  timezone?: string,
): Anomaly[] {
  const dates = dateRange(daysAgo(7, timezone), daysAgo(1, timezone));
  let belowCount = 0;
  let totalMinutes = 0;

  const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  for (const d of dates) {
    const ssUtc = localTimeToUtc(d, 18, tz);
    const seUtc = localTimeToUtc(nextDay(d), 18, tz);
    const dur = getSleepDurationForDate(db, d, ssUtc, seUtc);
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

function detectMissingData(db: DatabaseSync, timezone?: string): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const expectedTypes = [
    { type: 'HKQuantityTypeIdentifierHeartRate', label: 'Heart rate' },
    { type: 'HKQuantityTypeIdentifierStepCount', label: 'Steps' },
    {
      type: 'HKCategoryTypeIdentifierSleepAnalysis',
      label: 'Sleep analysis',
    },
  ];

  const twoDaysAgo = daysAgo(2, timezone);

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

function detectWorkoutSpike(db: DatabaseSync, timezone?: string): Anomaly[] {
  const thisWeekFrom = daysAgo(7, timezone);
  const thisWeekTo = daysAgo(0, timezone);
  const thisWeekTotal = getWorkoutTotalForRange(db, thisWeekFrom, thisWeekTo);

  if (thisWeekTotal === 0) return [];

  // Compare to 4-week average
  const fourWeeksFrom = daysAgo(28, timezone);
  const fourWeeksTo = daysAgo(8, timezone);
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

function detectWeightTrend(
  db: DatabaseSync,
  days: number,
  consecutiveThreshold: number,
  timezone?: string,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  const from = daysAgo(days, timezone);
  const to = daysAgo(0, timezone);
  const values = getDailyMetricValues(db, 'HKQuantityTypeIdentifierBodyMass', from, to);

  if (values.length < consecutiveThreshold + 1) return anomalies;

  // Deduplicate to one value per day (latest)
  const byDay = new Map<string, number>();
  for (const v of values) byDay.set(v.date, v.value);
  const daily = Array.from(byDay.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));

  if (daily.length < consecutiveThreshold + 1) return anomalies;

  // Check consecutive gain
  let gainCount = 0;
  for (let i = daily.length - 1; i > 0; i--) {
    if (daily[i].value > daily[i - 1].value) gainCount++;
    else break;
  }

  if (gainCount >= consecutiveThreshold) {
    const first = daily[daily.length - gainCount - 1].value;
    const last = daily[daily.length - 1].value;
    const delta = (last - first).toFixed(1);
    anomalies.push({
      severity: 'warning',
      title: 'Weight gaining trend',
      detail: `${gainCount + 1} consecutive readings increasing: ${first} → ${last} kg (+${delta} kg)`,
    });
  }

  // Check consecutive loss
  let lossCount = 0;
  for (let i = daily.length - 1; i > 0; i--) {
    if (daily[i].value < daily[i - 1].value) lossCount++;
    else break;
  }

  if (lossCount >= consecutiveThreshold) {
    const first = daily[daily.length - lossCount - 1].value;
    const last = daily[daily.length - 1].value;
    const delta = (first - last).toFixed(1);
    anomalies.push({
      severity: 'info',
      title: 'Weight losing trend',
      detail: `${lossCount + 1} consecutive readings decreasing: ${first} → ${last} kg (-${delta} kg)`,
    });
  }

  return anomalies;
}

function detectVo2MaxPlateau(
  db: DatabaseSync,
  days: number,
  timezone?: string,
): Anomaly[] {
  const from = daysAgo(days, timezone);
  const to = daysAgo(0, timezone);
  const values = getDailyMetricValues(db, 'HKQuantityTypeIdentifierVO2Max', from, to);

  // Need at least 4 readings to detect a plateau
  if (values.length < 4) return [];

  // Deduplicate to one per day
  const byDay = new Map<string, number>();
  for (const v of values) byDay.set(v.date, v.value);
  const daily = Array.from(byDay.values());

  if (daily.length < 4) return [];

  // Check if the range of values is very small (plateau = < 0.5 mL/kg·min spread)
  const min = Math.min(...daily);
  const max = Math.max(...daily);
  const spread = max - min;

  if (spread < 0.5) {
    const avg = (daily.reduce((a, b) => a + b, 0) / daily.length).toFixed(1);
    return [{
      severity: 'info',
      title: 'VO2 Max plateau',
      detail: `VO2 Max has been flat at ~${avg} mL/kg·min across ${daily.length} readings over the last ${days} days (spread: ${spread.toFixed(1)})`,
    }];
  }

  // Also check if the last N readings are all the same (exact plateau)
  const lastFour = daily.slice(-4);
  const lastSpread = Math.max(...lastFour) - Math.min(...lastFour);
  if (lastSpread < 0.3) {
    const avg = (lastFour.reduce((a, b) => a + b, 0) / lastFour.length).toFixed(1);
    return [{
      severity: 'info',
      title: 'VO2 Max plateau (recent)',
      detail: `Last ${lastFour.length} VO2 Max readings stable at ~${avg} mL/kg·min`,
    }];
  }

  return [];
}

export function executeAnomalyDetection(
  db: DatabaseSync,
  params: { days?: number; sensitivity?: string; timezone?: string },
): string {
  const { days = 14, sensitivity = 'medium', timezone } = params;

  const consecutiveThreshold = sensitivity === 'high' ? 2 : sensitivity === 'low' ? 4 : 3;
  const deviationThreshold = sensitivity === 'high' ? 5 : sensitivity === 'low' ? 15 : 10;
  const sleepThreshold = sensitivity === 'high' ? 7.5 * 60 : sensitivity === 'low' ? 6 * 60 : 7 * 60;

  const anomalies: Anomaly[] = [];

  anomalies.push(...detectTrend(db, 'HKQuantityTypeIdentifierRestingHeartRate', 'Resting HR', 'bpm', days, consecutiveThreshold, timezone));
  anomalies.push(...detectTrend(db, 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'HRV', 'ms', days, consecutiveThreshold, timezone));
  anomalies.push(...detectDeviation(db, 'HKQuantityTypeIdentifierRestingHeartRate', 'Resting HR', 'bpm', days, deviationThreshold, timezone));
  anomalies.push(...detectDeviation(db, 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', 'HRV', 'ms', days, deviationThreshold, timezone));
  anomalies.push(...detectSleepDeficit(db, sleepThreshold, timezone));
  anomalies.push(...detectMissingData(db, timezone));
  anomalies.push(...detectWorkoutSpike(db, timezone));
  anomalies.push(...detectWeightTrend(db, days, consecutiveThreshold, timezone));
  anomalies.push(...detectVo2MaxPlateau(db, days, timezone));

  if (anomalies.length === 0) {
    return `## Anomalies Check (last ${days} days)\n\n✅ No notable anomalies detected. All metrics within normal ranges.`;
  }

  const lines = [`## Anomalies Detected (last ${days} days)\n`];
  for (const a of anomalies) {
    const icon = a.severity === 'warning' ? '⚠️' : a.severity === 'info' ? 'ℹ️' : '✅';
    lines.push(`${icon} **${a.title}**: ${a.detail}\n`);
  }
  return lines.join('\n');
}

export function registerAnomaliesTool(
  api: PluginApi,
  db: DatabaseSync,
  timezone?: string,
): void {
  api.registerTool({
    name: 'health_anomalies',
    description:
      'Detect notable patterns and anomalies in recent health data. Checks for HR/HRV trends, metric deviations, sleep deficits, missing data, workout spikes, weight trends, and VO2 Max plateaus. Use for "anything unusual?" or "how is my recovery?"',
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
      const text = executeAnomalyDetection(db, { ...params as { days?: number; sensitivity?: string }, timezone });
      return { content: [{ type: 'text' as const, text }] };
    },
  });
}
