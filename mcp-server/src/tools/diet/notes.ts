import type { Pool } from '../../db.js';

export interface AddNoteInput {
  scope: 'day' | 'entry' | 'meal';
  text: string;
  day?: string; tz?: string;
  uuid?: string; id?: number;
  catering_meal_id?: number; meal_slot_key?: string;
}

export async function addNote(pool: Pool, input: AddNoteInput): Promise<{ ok: true }> {
  if (!input.text) throw new Error('text is required');
  const tz = input.tz ?? 'UTC';

  if (input.scope === 'day') {
    // Append (not replace — unlike health_log_day). Insert the row if absent.
    await pool.query(
      `INSERT INTO daily_logs (day, tz, notes)
       VALUES (COALESCE($1::date, (now() AT TIME ZONE $2)::date), $2, $3)
       ON CONFLICT (day) DO UPDATE
         SET notes = CASE WHEN daily_logs.notes IS NULL OR daily_logs.notes = ''
                          THEN EXCLUDED.notes
                          ELSE daily_logs.notes || E'\n' || EXCLUDED.notes END,
             updated_at = now()`,
      [input.day ?? null, tz, input.text]
    );
    return { ok: true };
  }

  if (input.scope === 'entry') {
    if (!input.uuid && input.id == null) throw new Error('entry scope requires uuid or id');
    const clause = input.uuid ? 'uuid = $1' : 'id = $1';
    const val: string | number = input.uuid ?? (input.id as number);
    const r = await pool.query(
      `UPDATE diet_consumption
          SET notes = CASE WHEN notes IS NULL OR notes = '' THEN $2
                           ELSE notes || E'\n' || $2 END,
              updated_at = now()
        WHERE ${clause} AND deleted_at IS NULL`,
      [val, input.text]
    );
    if ((r.rowCount ?? 0) === 0) throw new Error('diet_consumption entry not found');
    return { ok: true };
  }

  // scope === 'meal' — annotate a planned catering meal (no nutrition effect).
  let mealId = input.catering_meal_id ?? null;
  if (mealId == null) {
    if (!input.meal_slot_key) throw new Error('meal scope requires catering_meal_id or (day + meal_slot_key)');
    const m = await pool.query<{ id: string }>(
      `SELECT id FROM diet_catering_meals
        WHERE deleted_at IS NULL AND meal_slot_key = $1
          AND day = COALESCE($2::date, (now() AT TIME ZONE $3)::date)`,
      [input.meal_slot_key, input.day ?? null, tz]
    );
    if (m.rows.length === 0) throw new Error(`no catering meal for slot ${input.meal_slot_key} on that day`);
    if (m.rows.length > 1) throw new Error(`ambiguous catering meal for slot ${input.meal_slot_key}`);
    mealId = Number(m.rows[0].id);
  }
  await pool.query(
    `INSERT INTO diet_consumption (uuid, day, tz, kind, catering_meal_id, meal_slot_key, notes)
     VALUES (gen_random_uuid()::text,
             COALESCE($1::date, (now() AT TIME ZONE $2)::date), $2, 'note', $3, $4, $5)`,
    [input.day ?? null, tz, mealId, input.meal_slot_key ?? null, input.text]
  );
  return { ok: true };
}
