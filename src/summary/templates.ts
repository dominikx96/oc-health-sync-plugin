import type { WorkoutRow, SleepStageRow } from '../db/queries.js';
import { SLEEP_STAGES } from '../utils/constants.js';

export interface RollupSummaryData {
  from: string;
  to: string;
  daysCount: number;
  daysWithData: number;
  // Activity totals + daily averages
  totalSteps: number;
  avgDailySteps: number;
  totalActiveEnergy: number;
  totalBasalEnergy: number;
  totalDistance: number;
  totalFlightsClimbed: number;
  avgWalkingSpeed: number | null;
  // Workouts
  workoutCount: number;
  totalWorkoutMinutes: number;
  workoutTypes: Array<{ name: string; count: number; totalMinutes: number }>;
  // Vitals averages
  avgRestingHr: number | null;
  avgHrv: number | null;
  avgSpo2: number | null;
  avgRespiratoryRate: number | null;
  latestVo2Max: number | null;
  // Body
  weightStart: { value: number; unit: string } | null;
  weightEnd: { value: number; unit: string } | null;
  // Sleep
  avgSleepMinutes: number;
  avgSleepStages: SleepStageRow[];
  // Anomalies
  anomalies: string[];
}

export interface DailySummaryData {
  date: string;
  dayName: string;
  steps: number;
  activeEnergy: number;
  distance: number;
  workouts: WorkoutRow[];
  restingHr: number | null;
  restingHr7dAvg: number | null;
  hrv: number | null;
  hrv7dAvg: number | null;
  spo2: number | null;
  respiratoryRate: number | null;
  vo2Max: number | null;
  flightsClimbed: number;
  basalEnergy: number;
  walkingSpeed: number | null;
  weight: { value: number; unit: string } | null;
  sleepStages: SleepStageRow[];
  sleepStart: string | null;
  sleepEnd: string | null;
  anomalies: string[];
}

function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

function formatTime(isoDate: string): string {
  const d = new Date(isoDate);
  const hours = d.getHours();
  const mins = d.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  const h12 = hours % 12 || 12;
  return `${h12}:${mins} ${ampm}`;
}

function formatNumber(n: number, decimals = 0): string {
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function renderDailySummary(data: DailySummaryData): string {
  const sections: string[] = [];

  sections.push(`# Health Summary — ${data.date} (${data.dayName})`);

  // Activity
  if (data.steps > 0 || data.activeEnergy > 0 || data.distance > 0 || data.flightsClimbed > 0 || data.basalEnergy > 0) {
    const lines = ['## Activity'];
    if (data.steps > 0) lines.push(`- Steps: ${formatNumber(data.steps)}`);
    if (data.activeEnergy > 0)
      lines.push(`- Active energy: ${formatNumber(data.activeEnergy)} kcal`);
    if (data.basalEnergy > 0)
      lines.push(`- Basal energy: ${formatNumber(data.basalEnergy)} kcal`);
    if (data.activeEnergy > 0 && data.basalEnergy > 0)
      lines.push(`- Total energy: ${formatNumber(data.activeEnergy + data.basalEnergy)} kcal`);
    if (data.distance > 0)
      lines.push(
        `- Distance: ${formatNumber(data.distance / 1000, 1)} km`,
      );
    if (data.flightsClimbed > 0)
      lines.push(`- Flights climbed: ${formatNumber(data.flightsClimbed)}`);
    if (data.walkingSpeed !== null)
      lines.push(`- Walking speed: ${formatNumber(data.walkingSpeed, 1)} km/hr`);
    sections.push(lines.join('\n'));
  }

  // Workouts
  if (data.workouts.length > 0) {
    const lines = ['## Workouts'];
    for (const w of data.workouts) {
      const parts: string[] = [];
      if (w.workout_duration_seconds)
        parts.push(formatDuration(w.workout_duration_seconds / 60));
      if (w.workout_total_distance_m)
        parts.push(
          `${formatNumber(w.workout_total_distance_m / 1000, 1)} km`,
        );
      if (w.workout_total_energy_kcal)
        parts.push(`${formatNumber(w.workout_total_energy_kcal)} kcal`);

      const name = w.workout_activity_name ?? 'Workout';
      lines.push(`- ${name}: ${parts.join(', ')}`);
    }
    sections.push(lines.join('\n'));
  }

  // Vitals
  const vitalLines: string[] = [];
  if (data.restingHr !== null) {
    let line = `- Resting heart rate: ${data.restingHr} bpm`;
    if (data.restingHr7dAvg !== null)
      line += ` (7-day avg: ${data.restingHr7dAvg})`;
    vitalLines.push(line);
  }
  if (data.hrv !== null) {
    let line = `- HRV (SDNN): ${data.hrv} ms`;
    if (data.hrv7dAvg !== null) {
      line += ` (7-day avg: ${data.hrv7dAvg})`;
      if (data.hrv < data.hrv7dAvg * 0.9) line += ' ⚠️ below 7-day trend';
    }
    vitalLines.push(line);
  }
  if (data.spo2 !== null)
    vitalLines.push(`- SpO2: ${Math.round(data.spo2 * 100)}%`);
  if (data.respiratoryRate !== null)
    vitalLines.push(
      `- Respiratory rate: ${data.respiratoryRate} breaths/min`,
    );
  if (data.vo2Max !== null)
    vitalLines.push(`- VO2 Max: ${formatNumber(data.vo2Max, 1)} mL/kg·min`);
  if (vitalLines.length > 0) {
    sections.push(['## Vitals', ...vitalLines].join('\n'));
  }

  // Body
  if (data.weight) {
    sections.push(
      `## Body\n- Weight: ${formatNumber(data.weight.value, 1)} ${data.weight.unit} (last recorded)`,
    );
  }

  // Sleep
  const totalSleepMinutes = data.sleepStages
    .filter((s) => s.stage !== 0 && s.stage !== 2) // Exclude In Bed and Awake
    .reduce((sum, s) => sum + s.minutes, 0);

  if (totalSleepMinutes > 0) {
    const lines = ['## Sleep (previous night)'];

    let sleepWindow = '';
    if (data.sleepStart && data.sleepEnd) {
      sleepWindow = ` (${formatTime(data.sleepStart)} – ${formatTime(data.sleepEnd)})`;
    }
    lines.push(`- Total: ${formatDuration(totalSleepMinutes)}${sleepWindow}`);

    const stageBreakdown: string[] = [];
    for (const stage of data.sleepStages) {
      if (stage.stage === 0 || stage.stage === 2) continue; // Skip In Bed, Awake
      const name = SLEEP_STAGES[stage.stage] ?? `Stage ${stage.stage}`;
      stageBreakdown.push(`${name}: ${formatDuration(stage.minutes)}`);
    }

    const awakeStage = data.sleepStages.find((s) => s.stage === 2);
    if (awakeStage) {
      stageBreakdown.push(`Awake: ${formatDuration(awakeStage.minutes)}`);
    }

    if (stageBreakdown.length > 0) {
      lines.push(`- ${stageBreakdown.join(' | ')}`);
    }
    sections.push(lines.join('\n'));
  }

  // Notable
  if (data.anomalies.length > 0) {
    sections.push(
      ['## Notable', ...data.anomalies.map((a) => `- ${a}`)].join('\n'),
    );
  }

  return sections.join('\n\n') + '\n';
}

export function renderRollupSummary(data: RollupSummaryData): string {
  const sections: string[] = [];

  sections.push(
    `# Health Summary — ${data.from} to ${data.to} (${data.daysCount} days, ${data.daysWithData} with data)`,
  );

  // Activity
  if (data.totalSteps > 0 || data.totalActiveEnergy > 0 || data.totalDistance > 0) {
    const lines = ['## Activity'];
    if (data.totalSteps > 0) {
      lines.push(`- Steps: ${formatNumber(data.totalSteps)} total (${formatNumber(data.avgDailySteps)}/day avg)`);
    }
    if (data.totalActiveEnergy > 0) {
      lines.push(`- Active energy: ${formatNumber(data.totalActiveEnergy)} kcal total`);
    }
    if (data.totalBasalEnergy > 0) {
      lines.push(`- Basal energy: ${formatNumber(data.totalBasalEnergy)} kcal total`);
    }
    if (data.totalActiveEnergy > 0 && data.totalBasalEnergy > 0) {
      lines.push(`- Total energy: ${formatNumber(data.totalActiveEnergy + data.totalBasalEnergy)} kcal`);
    }
    if (data.totalDistance > 0) {
      lines.push(`- Distance: ${formatNumber(data.totalDistance / 1000, 1)} km total`);
    }
    if (data.totalFlightsClimbed > 0) {
      lines.push(`- Flights climbed: ${formatNumber(data.totalFlightsClimbed)} total`);
    }
    if (data.avgWalkingSpeed !== null) {
      lines.push(`- Walking speed: ${formatNumber(data.avgWalkingSpeed, 1)} km/hr avg`);
    }
    sections.push(lines.join('\n'));
  }

  // Workouts
  if (data.workoutCount > 0) {
    const lines = ['## Workouts'];
    lines.push(`- ${data.workoutCount} sessions, ${formatDuration(data.totalWorkoutMinutes)} total`);
    for (const wt of data.workoutTypes) {
      lines.push(`- ${wt.name}: ${wt.count}x, ${formatDuration(wt.totalMinutes)}`);
    }
    sections.push(lines.join('\n'));
  }

  // Vitals
  const vitalLines: string[] = [];
  if (data.avgRestingHr !== null) {
    vitalLines.push(`- Resting heart rate: ${data.avgRestingHr} bpm avg`);
  }
  if (data.avgHrv !== null) {
    vitalLines.push(`- HRV (SDNN): ${data.avgHrv} ms avg`);
  }
  if (data.avgSpo2 !== null) {
    vitalLines.push(`- SpO2: ${Math.round(data.avgSpo2 * 100)}% avg`);
  }
  if (data.avgRespiratoryRate !== null) {
    vitalLines.push(`- Respiratory rate: ${data.avgRespiratoryRate} breaths/min avg`);
  }
  if (data.latestVo2Max !== null) {
    vitalLines.push(`- VO2 Max: ${formatNumber(data.latestVo2Max, 1)} mL/kg·min (latest)`);
  }
  if (vitalLines.length > 0) {
    sections.push(['## Vitals', ...vitalLines].join('\n'));
  }

  // Body
  if (data.weightStart || data.weightEnd) {
    const lines = ['## Body'];
    if (data.weightStart && data.weightEnd) {
      const delta = data.weightEnd.value - data.weightStart.value;
      const sign = delta >= 0 ? '+' : '';
      lines.push(
        `- Weight: ${formatNumber(data.weightStart.value, 1)} → ${formatNumber(data.weightEnd.value, 1)} ${data.weightEnd.unit} (${sign}${formatNumber(delta, 1)})`,
      );
    } else {
      const w = data.weightStart ?? data.weightEnd!;
      lines.push(`- Weight: ${formatNumber(w.value, 1)} ${w.unit}`);
    }
    sections.push(lines.join('\n'));
  }

  // Sleep
  if (data.avgSleepMinutes > 0) {
    const lines = ['## Sleep (nightly average)'];
    lines.push(`- Average: ${formatDuration(data.avgSleepMinutes)}`);

    const stageBreakdown: string[] = [];
    for (const stage of data.avgSleepStages) {
      if (stage.stage === 0 || stage.stage === 2) continue;
      const name = SLEEP_STAGES[stage.stage] ?? `Stage ${stage.stage}`;
      stageBreakdown.push(`${name}: ${formatDuration(stage.minutes)}`);
    }
    if (stageBreakdown.length > 0) {
      lines.push(`- ${stageBreakdown.join(' | ')}`);
    }
    sections.push(lines.join('\n'));
  }

  // Notable
  if (data.anomalies.length > 0) {
    sections.push(
      ['## Notable', ...data.anomalies.map((a) => `- ${a}`)].join('\n'),
    );
  }

  return sections.join('\n\n') + '\n';
}
