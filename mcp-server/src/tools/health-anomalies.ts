import type { Pool } from '../db.js';

export interface HealthAnomaliesInput {
  window_days?: number;
}

interface AnomalyRow {
  kind: string;
  severity: string;
  detail: string;
  ref_date: Date;
}

const SEVERITY_ICON: Record<string, string> = { info: 'ℹ', warn: '⚠', alert: '🚨' };

export async function healthAnomalies(pool: Pool, input: HealthAnomaliesInput): Promise<string> {
  const window = Math.max(1, Math.min(180, input.window_days ?? 14));

  const r = await pool.query<AnomalyRow>(
    'SELECT kind, severity, detail, ref_date FROM detect_anomalies($1) ORDER BY ref_date DESC, severity',
    [window]
  );

  if (r.rows.length === 0) {
    return `# Health anomalies (last ${window} days)\n\n_No anomalies detected._`;
  }

  const lines = r.rows.map((row) => {
    const icon = SEVERITY_ICON[row.severity] ?? '•';
    const date = row.ref_date.toISOString().slice(0, 10);
    return `- ${icon} **${row.kind}** (${date}): ${row.detail}`;
  });

  return `# Health anomalies (last ${window} days)\n\n${lines.join('\n')}`;
}
