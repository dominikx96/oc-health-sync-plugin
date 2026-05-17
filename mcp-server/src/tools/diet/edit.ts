import type { Pool } from '../../db.js';

export interface UpdateEntryInput {
  uuid?: string; id?: number;
  meal_slot_key?: string; consumed_fraction?: number; swap_product_id?: number;
  name?: string; kcal?: number; protein_g?: number; carb_g?: number; fat_g?: number;
  saturated_fat_g?: number; fiber_g?: number; sugar_g?: number; salt_g?: number;
  weight_g?: number; source?: 'label_photo' | 'web_research' | 'estimate';
  photo_ref?: string; notes?: string;
}

function selector(input: { uuid?: string; id?: number }): { clause: string; val: string | number } {
  if (input.uuid) return { clause: 'uuid = $1', val: input.uuid };
  if (input.id != null) return { clause: 'id = $1', val: input.id };
  throw new Error('either uuid or id is required');
}

export async function updateEntry(pool: Pool, input: UpdateEntryInput): Promise<{ id: number }> {
  const sel = selector(input);
  // COALESCE-preserve: omitted (undefined → null param) keeps the prior value.
  const r = await pool.query<{ id: string }>(
    `UPDATE diet_consumption SET
       meal_slot_key     = COALESCE($2, meal_slot_key),
       consumed_fraction = COALESCE($3, consumed_fraction),
       swap_product_id   = COALESCE($4, swap_product_id),
       name              = COALESCE($5, name),
       kcal              = COALESCE($6, kcal),
       protein_g         = COALESCE($7, protein_g),
       carb_g            = COALESCE($8, carb_g),
       fat_g             = COALESCE($9, fat_g),
       saturated_fat_g   = COALESCE($10, saturated_fat_g),
       fiber_g           = COALESCE($11, fiber_g),
       sugar_g           = COALESCE($12, sugar_g),
       salt_g            = COALESCE($13, salt_g),
       weight_g          = COALESCE($14, weight_g),
       source            = COALESCE($15, source),
       photo_ref         = COALESCE($16, photo_ref),
       notes             = COALESCE($17, notes),
       updated_at        = now()
     WHERE ${sel.clause} AND deleted_at IS NULL
     RETURNING id`,
    [sel.val, input.meal_slot_key ?? null, input.consumed_fraction ?? null, input.swap_product_id ?? null,
     input.name ?? null, input.kcal ?? null, input.protein_g ?? null, input.carb_g ?? null,
     input.fat_g ?? null, input.saturated_fat_g ?? null, input.fiber_g ?? null, input.sugar_g ?? null,
     input.salt_g ?? null, input.weight_g ?? null, input.source ?? null, input.photo_ref ?? null,
     input.notes ?? null]
  );
  if (!r.rows[0]) throw new Error('diet_consumption entry not found');
  return { id: Number(r.rows[0].id) };
}

export async function deleteEntry(pool: Pool, input: { uuid?: string; id?: number }): Promise<{ id: number }> {
  const sel = selector(input);
  const r = await pool.query<{ id: string }>(
    `UPDATE diet_consumption SET deleted_at = now(), updated_at = now()
      WHERE ${sel.clause} AND deleted_at IS NULL
      RETURNING id`,
    [sel.val]
  );
  if (!r.rows[0]) throw new Error('diet_consumption entry not found');
  return { id: Number(r.rows[0].id) };
}
