export interface DailyRow {
  day: Date;
  total_steps: number | null;
  avg_heart_rate: number | null;
  resting_heart_rate: number | null;
  hrv_mean: number | null;
  sleep_minutes: number | null;
  workout_count: number;
}

const fmtNum = (n: number | null, opts?: Intl.NumberFormatOptions) =>
  n === null ? '—' : new Intl.NumberFormat('en-US', opts).format(n);

const fmtMinutes = (m: number | null) => {
  if (m === null) return '—';
  const h = Math.floor(m / 60);
  const mm = Math.round(m % 60);
  return `${h}h ${mm}m`;
};

export function renderDaily(date: string, row: DailyRow | undefined): string {
  if (!row) return `# Daily summary — ${date}\n\n_No data._`;
  return [
    `# Daily summary — ${date}`,
    '',
    `- **Steps:** ${fmtNum(row.total_steps, { maximumFractionDigits: 0 })}`,
    `- **Heart rate (avg):** ${fmtNum(row.avg_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Resting HR:** ${fmtNum(row.resting_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **HRV:** ${fmtNum(row.hrv_mean, { maximumFractionDigits: 1 })} ms`,
    `- **Sleep:** ${fmtMinutes(row.sleep_minutes)}`,
    `- **Workouts:** ${row.workout_count}`
  ].join('\n');
}

export function renderWeekly(weekStart: string, row: DailyRow | undefined): string {
  if (!row) return `# Weekly summary — week of ${weekStart}\n\n_No data._`;
  return [
    `# Weekly summary — week of ${weekStart}`,
    '',
    `- **Total steps:** ${fmtNum(row.total_steps, { maximumFractionDigits: 0 })}`,
    `- **Avg heart rate:** ${fmtNum(row.avg_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Avg resting HR:** ${fmtNum(row.resting_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Avg HRV:** ${fmtNum(row.hrv_mean, { maximumFractionDigits: 1 })} ms`,
    `- **Total sleep:** ${fmtMinutes(row.sleep_minutes)}`,
    `- **Workouts:** ${row.workout_count}`
  ].join('\n');
}

export function renderMonthly(monthStart: string, row: DailyRow | undefined): string {
  if (!row) return `# Monthly summary — ${monthStart}\n\n_No data._`;
  return [
    `# Monthly summary — ${monthStart}`,
    '',
    `- **Total steps:** ${fmtNum(row.total_steps, { maximumFractionDigits: 0 })}`,
    `- **Avg heart rate:** ${fmtNum(row.avg_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Avg resting HR:** ${fmtNum(row.resting_heart_rate, { maximumFractionDigits: 0 })} bpm`,
    `- **Avg HRV:** ${fmtNum(row.hrv_mean, { maximumFractionDigits: 1 })} ms`,
    `- **Total sleep:** ${fmtMinutes(row.sleep_minutes)}`,
    `- **Workouts:** ${row.workout_count}`
  ].join('\n');
}
