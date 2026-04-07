import type { DatabaseSync } from 'node:sqlite';
import type { WorkoutRow } from '../db/queries.js';
import {
  getStepsForDate,
  getActiveEnergyForDate,
  getDistanceForDate,
  getWorkouts,
  getLatestMetricForDate,
  getAvgMetricForRange,
  getAggregation,
  getSleepStages,
  getSleepWindow,
  getLatestWeightUpTo,
  getDataHash,
  getCachedSummary,
  setCachedSummary,
  getDailyMetricValues,
} from '../db/queries.js';
import { renderDailySummary, renderRollupSummary } from './templates.js';
import type { DailySummaryData, RollupSummaryData } from './templates.js';

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

  const vo2Max = getLatestMetricForDate(
    db,
    'HKQuantityTypeIdentifierVO2Max',
    date,
  );
  const flightsResult = getAggregation(
    db,
    'HKQuantityTypeIdentifierFlightsClimbed',
    date,
    date,
    'sum',
  );
  const flightsClimbed = flightsResult.value ?? 0;
  const basalResult = getAggregation(
    db,
    'HKQuantityTypeIdentifierBasalEnergyBurned',
    date,
    date,
    'sum',
  );
  const basalEnergy = basalResult.value ?? 0;
  const walkingSpeed = getLatestMetricForDate(
    db,
    'HKQuantityTypeIdentifierWalkingSpeed',
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
    vo2Max,
    flightsClimbed,
    basalEnergy,
    walkingSpeed,
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

function generateRollupSummary(
  db: DatabaseSync,
  from: string,
  to: string,
): string {
  const dates = dateRange(from, to);
  const sevenDaysBefore_ = sevenDaysBefore(from);

  // Activity aggregates
  let totalSteps = 0;
  let totalActiveEnergy = 0;
  let totalBasalEnergy = 0;
  let totalDistance = 0;
  let totalFlightsClimbed = 0;
  let daysWithData = 0;

  for (const d of dates) {
    const steps = getStepsForDate(db, d);
    const active = getActiveEnergyForDate(db, d);
    const dist = getDistanceForDate(db, d);
    const flightsResult = getAggregation(db, 'HKQuantityTypeIdentifierFlightsClimbed', d, d, 'sum');
    const basalResult = getAggregation(db, 'HKQuantityTypeIdentifierBasalEnergyBurned', d, d, 'sum');

    totalSteps += steps;
    totalActiveEnergy += active;
    totalDistance += dist;
    totalFlightsClimbed += flightsResult.value ?? 0;
    totalBasalEnergy += basalResult.value ?? 0;

    if (steps > 0 || active > 0) daysWithData++;
  }

  const avgDailySteps = daysWithData > 0 ? Math.round(totalSteps / daysWithData) : 0;

  // Walking speed average
  const walkingSpeedResult = getAvgMetricForRange(
    db,
    'HKQuantityTypeIdentifierWalkingSpeed',
    from,
    to,
  );

  // Workouts
  const allWorkouts: WorkoutRow[] = [];
  for (const d of dates) {
    allWorkouts.push(...getWorkouts(db, d));
  }
  const workoutTypeMap = new Map<string, { count: number; totalMinutes: number }>();
  let totalWorkoutMinutes = 0;
  for (const w of allWorkouts) {
    const name = w.workout_activity_name ?? 'Workout';
    const mins = (w.workout_duration_seconds ?? 0) / 60;
    totalWorkoutMinutes += mins;
    const entry = workoutTypeMap.get(name) ?? { count: 0, totalMinutes: 0 };
    entry.count++;
    entry.totalMinutes += mins;
    workoutTypeMap.set(name, entry);
  }
  const workoutTypes = Array.from(workoutTypeMap.entries())
    .map(([name, data]) => ({ name, count: data.count, totalMinutes: Math.round(data.totalMinutes) }))
    .sort((a, b) => b.count - a.count);

  // Vitals
  const avgRestingHr = getAvgMetricForRange(db, 'HKQuantityTypeIdentifierRestingHeartRate', from, to);
  const avgHrv = getAvgMetricForRange(db, 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN', from, to);
  const avgSpo2 = getAvgMetricForRange(db, 'HKQuantityTypeIdentifierOxygenSaturation', from, to);
  const avgRespiratoryRate = getAvgMetricForRange(db, 'HKQuantityTypeIdentifierRespiratoryRate', from, to);
  const latestVo2Max = getLatestMetricForDate(db, 'HKQuantityTypeIdentifierVO2Max', to);

  // Weight
  const weightStart = getLatestWeightUpTo(db, from);
  const weightEnd = getLatestWeightUpTo(db, to);

  // Sleep averages
  let totalSleepMinutes = 0;
  let sleepNights = 0;
  const stageTotals = new Map<number, number>();
  for (const d of dates) {
    const stages = getSleepStages(db, d);
    const nightMinutes = stages
      .filter((s) => s.stage !== 0 && s.stage !== 2)
      .reduce((sum, s) => sum + s.minutes, 0);
    if (nightMinutes > 0) {
      sleepNights++;
      totalSleepMinutes += nightMinutes;
      for (const s of stages) {
        stageTotals.set(s.stage, (stageTotals.get(s.stage) ?? 0) + s.minutes);
      }
    }
  }
  const avgSleepMinutes = sleepNights > 0 ? Math.round(totalSleepMinutes / sleepNights) : 0;
  const avgSleepStages = sleepNights > 0
    ? Array.from(stageTotals.entries()).map(([stage, total]) => ({
        stage,
        minutes: Math.round(total / sleepNights),
      }))
    : [];

  // Anomalies (collect from daily anomaly detection)
  const allAnomalies: string[] = [];
  // Check HRV trend over the period
  const restingHr7dAvg = getAvgMetricForRange(db, 'HKQuantityTypeIdentifierRestingHeartRate', sevenDaysBefore_, from);
  if (avgRestingHr !== null && restingHr7dAvg !== null && restingHr7dAvg > 0) {
    const pctDiff = ((avgRestingHr - restingHr7dAvg) / restingHr7dAvg) * 100;
    if (pctDiff > 6) {
      allAnomalies.push(
        `Resting HR elevated over period: ${avgRestingHr} bpm avg vs prior 7-day avg ${restingHr7dAvg} bpm (+${pctDiff.toFixed(1)}%)`,
      );
    }
  }

  const data: RollupSummaryData = {
    from,
    to,
    daysCount: dates.length,
    daysWithData,
    totalSteps,
    avgDailySteps,
    totalActiveEnergy: Math.round(totalActiveEnergy),
    totalBasalEnergy: Math.round(totalBasalEnergy),
    totalDistance: Math.round(totalDistance),
    totalFlightsClimbed: Math.round(totalFlightsClimbed),
    avgWalkingSpeed: walkingSpeedResult,
    workoutCount: allWorkouts.length,
    totalWorkoutMinutes: Math.round(totalWorkoutMinutes),
    workoutTypes,
    avgRestingHr,
    avgHrv,
    avgSpo2,
    avgRespiratoryRate,
    latestVo2Max,
    weightStart: weightStart ? { value: weightStart.value, unit: weightStart.unit } : null,
    weightEnd: weightEnd ? { value: weightEnd.value, unit: weightEnd.unit } : null,
    avgSleepMinutes,
    avgSleepStages,
    anomalies: allAnomalies,
  };

  return renderRollupSummary(data);
}

export type SummaryMode = 'daily' | 'rollup' | 'auto';

export function generateSummary(
  db: DatabaseSync,
  from: string,
  to: string,
  cacheTtlMinutes: number,
  mode: SummaryMode = 'auto',
): string {
  const dates = dateRange(from, to);

  if (dates.length === 0) {
    return 'No dates in the specified range.';
  }

  if (dates.length === 1) {
    return generateDaySummary(db, dates[0], cacheTtlMinutes);
  }

  const useRollup = mode === 'rollup' || (mode === 'auto' && dates.length > 3);

  if (useRollup) {
    return generateRollupSummary(db, from, to);
  }

  // Multi-day daily mode: compose individual summaries
  const summaries = dates.map((d) => generateDaySummary(db, d, cacheTtlMinutes));

  const header = `# Health Summary — ${from} to ${to} (${dates.length} days)\n`;
  return header + '\n---\n\n' + summaries.join('\n---\n\n');
}
