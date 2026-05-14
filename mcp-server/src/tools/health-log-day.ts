import type { Pool } from '../db.js';

export interface HealthLogDayInput {
  date?: string;     // YYYY-MM-DD; default = today in `tz`
  tz?: string;       // IANA tz; default = 'UTC'
  alcohol?: boolean; // undefined => leave existing value untouched on upsert
  notes?: string;    // undefined => leave existing value untouched on upsert
}

export interface HealthLogDayResult {
  day: string;       // YYYY-MM-DD
  tz: string;
  alcohol: boolean | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export async function healthLogDay(
  pool: Pool,
  input: HealthLogDayInput
): Promise<HealthLogDayResult> {
  const tz = input.tz ?? 'UTC';

  // COALESCE on EXCLUDED.<col> vs daily_logs.<col>:
  //   if the caller supplied a non-null value, EXCLUDED wins;
  //   if the caller passed undefined (→ NULL via $param), the prior value is preserved.
  // tz is always overwritten — it always has a non-null value (default 'UTC').
  const sql = `
    INSERT INTO daily_logs (day, tz, alcohol, notes)
    VALUES (
      COALESCE($1::date, (now() AT TIME ZONE $2)::date),
      $2,
      $3,
      $4
    )
    ON CONFLICT (day) DO UPDATE
       SET tz         = EXCLUDED.tz,
           alcohol    = COALESCE(EXCLUDED.alcohol, daily_logs.alcohol),
           notes      = COALESCE(EXCLUDED.notes, daily_logs.notes),
           updated_at = now()
    RETURNING to_char(day, 'YYYY-MM-DD') AS day,
              tz,
              alcohol,
              notes,
              created_at::text,
              updated_at::text
  `;
  const r = await pool.query<HealthLogDayResult>(sql, [
    input.date ?? null,
    tz,
    input.alcohol ?? null,
    input.notes ?? null
  ]);
  return r.rows[0];
}
