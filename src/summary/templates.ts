import type { WorkoutRow, SleepStageRow } from '../db/queries.js';
import { SLEEP_STAGES } from '../utils/constants.js';

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
  if (data.steps > 0 || data.activeEnergy > 0 || data.distance > 0) {
    const lines = ['## Activity'];
    if (data.steps > 0) lines.push(`- Steps: ${formatNumber(data.steps)}`);
    if (data.activeEnergy > 0)
      lines.push(`- Active energy: ${formatNumber(data.activeEnergy)} kcal`);
    if (data.distance > 0)
      lines.push(
        `- Distance: ${formatNumber(data.distance / 1000, 1)} km`,
      );
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
