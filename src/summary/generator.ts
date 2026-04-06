import type { DatabaseSync } from 'node:sqlite';
import {
  getStepsForDate,
  getActiveEnergyForDate,
  getDistanceForDate,
  getWorkouts,
  getLatestMetricForDate,
  getAvgMetricForRange,
  getSleepStages,
  getSleepWindow,
  getLatestWeightUpTo,
  getDataHash,
  getCachedSummary,
  setCachedSummary,
  getDailyMetricValues,
} from '../db/queries.js';
import { renderDailySummary } from './templates.js';
import type { DailySummaryData } from './templates.js';

function getDayName(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long' });
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

function sevenDaysBefore(date: string): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

function detectDailyAnomalies(
  db: DatabaseSync,
  date: string,
  restingHr: number | null,
  restingHr7dAvg: number | null,
  hrv: number | null,
  hrv7dAvg: number | null,
): string[] {
  const anomalies: string[] = [];

  // Check HRV consecutive decline
  if (hrv !== null) {
    const recentHrvValues = getDailyMetricValues(
      db,
      'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
      sevenDaysBefore(date),
      date,
    );

    if (recentHrvValues.length >= 3) {
      const last3 = recentHrvValues.slice(-3);
      if (last3[0].value > last3[1].value && last3[1].value > last3[2].value) {
        anomalies.push(
          `HRV declined 3 consecutive days (${last3.map((v) => v.value + ' ms').join(' → ')})`,
        );
      }
    }
  }

  // Check resting HR elevation
  if (restingHr !== null && restingHr7dAvg !== null && restingHr7dAvg > 0) {
    const pctDiff =
      ((restingHr - restingHr7dAvg) / restingHr7dAvg) * 100;
    if (pctDiff > 6) {
      anomalies.push(
        `Resting HR elevated: ${restingHr} bpm vs 7-day avg ${restingHr7dAvg} bpm (+${pctDiff.toFixed(1)}%)`,
      );
    }
  }

  return anomalies;
}

function generateDaySummary(
  db: DatabaseSync,
  date: string,
  cacheTtlMinutes: number,
): string {
  // Check cache
  const hash = getDataHash(db, date);
  const today = new Date().toISOString().slice(0, 10);

  if (date !== today) {
    const cached = getCachedSummary(db, date);
    if (cached && cached.data_hash === hash) {
      if (cacheTtlMinutes <= 0) {
        // TTL=0 means always regenerate, but still use hash match
      } else {
        const age =
          (Date.now() - new Date(cached.generated_at + 'Z').getTime()) /
          60000;
        if (age < cacheTtlMinutes) {
          return cached.markdown;
        }
      }
    }
  }

  const sevenDaysAgo = sevenDaysBefore(date);

  const steps = getStepsForDate(db, date);
  const activeEnergy = getActiveEnergyForDate(db, date);
  const distance = getDistanceForDate(db, date);
  const workouts = getWorkouts(db, date);

  const restingHr = getLatestMetricForDate(
    db,
    'HKQuantityTypeIdentifierRestingHeartRate',
    date,
  );
  const restingHr7dAvg = getAvgMetricForRange(
    db,
    'HKQuantityTypeIdentifierRestingHeartRate',
    sevenDaysAgo,
    date,
  );

  const hrv = getLatestMetricForDate(
    db,
    'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    date,
  );
  const hrv7dAvg = getAvgMetricForRange(
    db,
    'HKQuantityTypeIdentifierHeartRateVariabilitySDNN',
    sevenDaysAgo,
    date,
  );

  const spo2 = getLatestMetricForDate(
    db,
    'HKQuantityTypeIdentifierOxygenSaturation',
    date,
  );
  const respiratoryRate = getLatestMetricForDate(
    db,
    'HKQuantityTypeIdentifierRespiratoryRate',
    date,
  );

  const weightRow = getLatestWeightUpTo(db, date);
  const sleepStages = getSleepStages(db, date);
  const sleepWindow = getSleepWindow(db, date);

  const anomalies = detectDailyAnomalies(
    db,
    date,
    restingHr,
    restingHr7dAvg,
    hrv,
    hrv7dAvg,
  );

  const data: DailySummaryData = {
    date,
    dayName: getDayName(date),
    steps,
    activeEnergy,
    distance,
    workouts,
    restingHr,
    restingHr7dAvg,
    hrv,
    hrv7dAvg,
    spo2,
    respiratoryRate,
    weight: weightRow ? { value: weightRow.value, unit: weightRow.unit } : null,
    sleepStages,
    sleepStart: sleepWindow.sleep_start,
    sleepEnd: sleepWindow.sleep_end,
    anomalies,
  };

  const markdown = renderDailySummary(data);

  // Cache (not for today since data is still accumulating)
  if (date !== today) {
    setCachedSummary(db, date, '', markdown, hash);
  }

  return markdown;
}

export function generateSummary(
  db: DatabaseSync,
  from: string,
  to: string,
  cacheTtlMinutes: number,
): string {
  const dates = dateRange(from, to);

  if (dates.length === 0) {
    return 'No dates in the specified range.';
  }

  if (dates.length === 1) {
    return generateDaySummary(db, dates[0], cacheTtlMinutes);
  }

  // Multi-day: compose individual summaries
  const summaries = dates.map((d) => generateDaySummary(db, d, cacheTtlMinutes));

  const header = `# Health Summary — ${from} to ${to} (${dates.length} days)\n`;
  return header + '\n---\n\n' + summaries.join('\n---\n\n');
}
