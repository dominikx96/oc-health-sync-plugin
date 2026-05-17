import type { Pool } from '../../db.js';

export interface LogMealInput {
  uuid: string; date?: string; tz?: string; meal_slot_key?: string;
  name: string; kcal: number;
  protein_g?: number; carb_g?: number; fat_g?: number; saturated_fat_g?: number;
  fiber_g?: number; sugar_g?: number; salt_g?: number; weight_g?: number;
  source: 'label_photo' | 'web_research' | 'estimate';
  photo_ref?: string; notes?: string;
}
export interface LogResult { id: number }

export async function logMeal(pool: Pool, input: LogMealInput): Promise<LogResult> {
  if (!input.uuid) throw new Error('uuid is required');
  if (!input.name || input.kcal == null) throw new Error('adhoc meal requires name and kcal');
  const tz = input.tz ?? 'UTC';

  const existing = await pool.query<{ id: string }>(`SELECT id FROM diet_consumption WHERE uuid=$1`, [input.uuid]);
  if (existing.rows[0]) return { id: Number(existing.rows[0].id) };

  const r = await pool.query<{ id: string }>(
    `INSERT INTO diet_consumption
       (uuid, day, tz, kind, meal_slot_key, name, kcal, protein_g, carb_g, fat_g,
        saturated_fat_g, fiber_g, sugar_g, salt_g, weight_g, source, photo_ref, notes)
     VALUES ($1, COALESCE($2::date, (now() AT TIME ZONE $3)::date), $3, 'adhoc',
             $4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING id`,
    [input.uuid, input.date ?? null, tz, input.meal_slot_key ?? null, input.name, input.kcal,
     input.protein_g ?? null, input.carb_g ?? null, input.fat_g ?? null, input.saturated_fat_g ?? null,
     input.fiber_g ?? null, input.sugar_g ?? null, input.salt_g ?? null, input.weight_g ?? null,
     input.source, input.photo_ref ?? null, input.notes ?? null]
  );
  return { id: Number(r.rows[0].id) };
}

export interface LogDeviationInput {
  uuid: string; kind: 'skip' | 'partial' | 'swap';
  day?: string; tz?: string; meal_slot_key?: string; catering_meal_id?: number;
  consumed_fraction?: number; swap_product_id?: number; notes?: string;
}

export async function logDeviation(pool: Pool, input: LogDeviationInput): Promise<LogResult> {
  if (!input.uuid) throw new Error('uuid is required');
  if (!['skip', 'partial', 'swap'].includes(input.kind)) throw new Error(`invalid kind: ${input.kind}`);
  if (input.kind === 'partial' && input.consumed_fraction == null) throw new Error('partial requires consumed_fraction');
  if (input.kind === 'swap' && input.swap_product_id == null) throw new Error('swap requires swap_product_id');
  const tz = input.tz ?? 'UTC';

  const existing = await pool.query<{ id: string }>(`SELECT id FROM diet_consumption WHERE uuid=$1`, [input.uuid]);
  if (existing.rows[0]) return { id: Number(existing.rows[0].id) };

  let mealId = input.catering_meal_id ?? null;
  let day = input.day ?? null;
  if (mealId == null) {
    if (!input.meal_slot_key) throw new Error('either catering_meal_id or (day + meal_slot_key) is required');
    const resolveDay = input.day ?? null;
    const m = await pool.query<{ id: string; day: string }>(
      `SELECT id, to_char(day,'YYYY-MM-DD') AS day FROM diet_catering_meals
        WHERE deleted_at IS NULL AND meal_slot_key = $1
          AND day = COALESCE($2::date, (now() AT TIME ZONE $3)::date)`,
      [input.meal_slot_key, resolveDay, tz]
    );
    if (m.rows.length === 0) throw new Error(`no catering meal for slot ${input.meal_slot_key} on that day`);
    if (m.rows.length > 1) throw new Error(`ambiguous: multiple catering meals for slot ${input.meal_slot_key} that day`);
    mealId = Number(m.rows[0].id);
    day = m.rows[0].day;
  } else {
    const m = await pool.query<{ day: string }>(`SELECT to_char(day,'YYYY-MM-DD') AS day FROM diet_catering_meals WHERE id=$1`, [mealId]);
    if (!m.rows[0]) throw new Error(`catering_meal_id ${mealId} not found`);
    day = m.rows[0].day;
  }

  const r = await pool.query<{ id: string }>(
    `INSERT INTO diet_consumption
       (uuid, day, tz, kind, catering_meal_id, consumed_fraction, swap_product_id, notes)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [input.uuid, day, tz, input.kind, mealId, input.consumed_fraction ?? null,
     input.swap_product_id ?? null, input.notes ?? null]
  );
  return { id: Number(r.rows[0].id) };
}
