import type { Pool } from '../../db.js';

interface Envelope { data?: { result_count?: number; results?: any[]; includes?: any; aggregates?: any[] } }

export interface SyncSubscriptionsResult { upserted: number }

export async function syncSubscriptions(pool: Pool, raw: unknown): Promise<SyncSubscriptionsResult> {
  const env = raw as Envelope;
  const rows = env?.data?.results;
  if (!Array.isArray(rows)) throw new Error('invalid payload: data.results is not an array');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let upserted = 0;
    for (const r of rows) {
      await client.query(
        `INSERT INTO diet_subscriptions
           (delivery_diet_id, diet_id, user_diet_name, plan_kcal,
            first_delivery_day, last_delivery_day, status, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
         ON CONFLICT (delivery_diet_id) DO UPDATE SET
           diet_id            = EXCLUDED.diet_id,
           user_diet_name     = EXCLUDED.user_diet_name,
           plan_kcal          = EXCLUDED.plan_kcal,
           first_delivery_day = EXCLUDED.first_delivery_day,
           last_delivery_day  = EXCLUDED.last_delivery_day,
           status             = EXCLUDED.status,
           raw                = EXCLUDED.raw,
           updated_at         = now()`,
        [r.id, r.diet_id ?? null, r.user_diet_name ?? null, r.kcal ?? null,
         r.first_delivery_day ?? null, r.last_delivery_day ?? null, r.status ?? null, r]
      );
      upserted += 1;
    }
    await client.query('COMMIT');
    return { upserted };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface SyncCateringDayResult {
  products: number; meals: number; day: string | null;
  no_delivery: boolean; warnings: string[];
}

const NUTR = (sp: any) => ({
  kcal: sp?.calorific ?? null, kj: sp?.kj ?? null,
  protein_g: sp?.protein ?? null, carb_g: sp?.carb ?? null, fat_g: sp?.fat ?? null,
  saturated_fat_g: sp?.saturated_fat ?? null, fiber_g: sp?.fiber ?? null,
  sugar_g: sp?.sugar ?? null, salt_g: sp?.salt ?? null,
  protein_pct: sp?.protein_percent ?? null, carb_pct: sp?.carb_percent ?? null,
  fat_pct: sp?.fat_percent ?? null
});

export async function syncCateringDay(pool: Pool, raw: unknown): Promise<SyncCateringDayResult> {
  const env = raw as Envelope;
  const data = env?.data;
  if (!data) throw new Error('invalid payload: missing data');
  const results = Array.isArray(data.results) ? data.results : [];
  if ((data.result_count ?? results.length) === 0 || results.length === 0) {
    return { products: 0, meals: 0, day: null, no_delivery: true, warnings: [] };
  }

  const delivery = results[0];
  const inc = data.includes ?? {};
  const items: any[]   = Array.isArray(inc.delivery_items) ? inc.delivery_items : [];
  const products: any[] = Array.isArray(inc.simple_products) ? inc.simple_products : [];
  const dvMeals: any[]  = Array.isArray(inc.diet_variant_meals) ? inc.diet_variant_meals : [];
  const dvTypes: any[]  = Array.isArray(inc.diet_variant_meal_types) ? inc.diet_variant_meal_types : [];
  const alts: any[]     = Array.isArray(inc.alternative_meals) ? inc.alternative_meals : [];
  const aggregates: any[] = Array.isArray(data.aggregates) ? data.aggregates : [];

  const day: string = delivery.date;
  const deliveryDietId: number | undefined =
    items.find((i) => i.delivery_diet_id != null)?.delivery_diet_id;
  if (deliveryDietId == null) throw new Error('cannot determine delivery_diet_id from payload');

  const typeById = new Map<number, any>(dvTypes.map((t) => [t.id, t]));
  const dvMealById = new Map<number, any>(dvMeals.map((m) => [m.id, m]));
  const altByItem = new Map<number, number[]>(
    alts.map((a) => [a.delivery_item_id, Array.isArray(a.simple_product_ids) ? a.simple_product_ids : []])
  );
  const productById = new Map<number, any>(products.map((p) => [p.id, p]));
  const warnings: string[] = [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // FK safety: ensure a subscription row exists (stub if syncSubscriptions wasn't called).
    await client.query(
      `INSERT INTO diet_subscriptions (delivery_diet_id) VALUES ($1)
         ON CONFLICT (delivery_diet_id) DO NOTHING`,
      [deliveryDietId]
    );

    // Products (crc32-gated).
    let productCount = 0;
    const upsertProduct = async (sp: any, stub = false) => {
      const n = NUTR(sp);
      await client.query(
        `INSERT INTO diet_products
           (simple_product_id, name, composition, weight_g, kind,
            kcal, kj, protein_g, carb_g, fat_g, saturated_fat_g, fiber_g, sugar_g, salt_g,
            protein_pct, carb_pct, fat_pct, categories, allergens, images, crc32, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22, now())
         ON CONFLICT (simple_product_id) DO UPDATE SET
           name=EXCLUDED.name, composition=EXCLUDED.composition, weight_g=EXCLUDED.weight_g,
           kind=EXCLUDED.kind, kcal=EXCLUDED.kcal, kj=EXCLUDED.kj, protein_g=EXCLUDED.protein_g,
           carb_g=EXCLUDED.carb_g, fat_g=EXCLUDED.fat_g, saturated_fat_g=EXCLUDED.saturated_fat_g,
           fiber_g=EXCLUDED.fiber_g, sugar_g=EXCLUDED.sugar_g, salt_g=EXCLUDED.salt_g,
           protein_pct=EXCLUDED.protein_pct, carb_pct=EXCLUDED.carb_pct, fat_pct=EXCLUDED.fat_pct,
           categories=EXCLUDED.categories, allergens=EXCLUDED.allergens, images=EXCLUDED.images,
           crc32=EXCLUDED.crc32, raw=EXCLUDED.raw, updated_at=now()
         WHERE diet_products.crc32 IS DISTINCT FROM EXCLUDED.crc32`,
        [
          sp.id, sp.name ?? (stub ? `product ${sp.id}` : null), sp.composition ?? null,
          sp.weight ?? null, sp.kind ?? null,
          n.kcal, n.kj, n.protein_g, n.carb_g, n.fat_g, n.saturated_fat_g, n.fiber_g, n.sugar_g, n.salt_g,
          n.protein_pct, n.carb_pct, n.fat_pct,
          (sp.categories ?? []).map((c: any) => c?.tag_value?.key).filter(Boolean),
          (sp.allergens ?? []).map((a: any) => a?.tag_value?.key).filter(Boolean),
          sp.images ? JSON.stringify(sp.images) : null,
          stub ? null : (sp.crc32 ?? null), JSON.stringify(sp)
        ]
      );
      productCount += 1;
    };
    for (const sp of products) await upsertProduct(sp);

    // Meals.
    let mealCount = 0;
    for (const it of items) {
      if (it.simple_product_id != null && !productById.has(it.simple_product_id)) {
        warnings.push(`simple_product_id ${it.simple_product_id} missing from includes — stubbed`);
        await upsertProduct({ id: it.simple_product_id }, true);
      }
      const dvm  = dvMealById.get(it.diet_variant_meal_id);
      const slot = dvm ? typeById.get(dvm.diet_variant_meal_type_id) : undefined;
      await client.query(
        `INSERT INTO diet_catering_meals
           (delivery_item_id, delivery_diet_id, delivery_id, day, diet_variant_meal_id,
            meal_slot_key, meal_slot_name, meal_slot_position, simple_product_id,
            slot_kcal_target, status, alternative_product_ids, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
         ON CONFLICT (delivery_item_id) DO UPDATE SET
           delivery_diet_id=EXCLUDED.delivery_diet_id, delivery_id=EXCLUDED.delivery_id,
           day=EXCLUDED.day, diet_variant_meal_id=EXCLUDED.diet_variant_meal_id,
           meal_slot_key=EXCLUDED.meal_slot_key, meal_slot_name=EXCLUDED.meal_slot_name,
           meal_slot_position=EXCLUDED.meal_slot_position, simple_product_id=EXCLUDED.simple_product_id,
           slot_kcal_target=EXCLUDED.slot_kcal_target, status=EXCLUDED.status,
           alternative_product_ids=EXCLUDED.alternative_product_ids, raw=EXCLUDED.raw, updated_at=now()`,
        [
          it.id, it.delivery_diet_id ?? deliveryDietId, it.delivery_id ?? delivery.id, day,
          it.diet_variant_meal_id ?? null,
          slot?.meal_name?.key ?? null, slot?.meal_name?.value ?? null, slot?.position ?? null,
          it.simple_product_id ?? null, dvm?.kcal ?? null, it.status ?? null,
          altByItem.get(it.id) ?? [], JSON.stringify(it)
        ]
      );
      mealCount += 1;
    }

    // Day aggregate (pivot the aggregates array by name).
    const agg = new Map<string, number>(aggregates.map((a) => [a.name, a.value]));
    await client.query(
      `INSERT INTO diet_catering_day
         (delivery_diet_id, day, plan_kcal, kcal, kj, protein_g, carb_g, fat_g,
          saturated_fat_g, fiber_g, sugar_g, salt_g, protein_pct, carb_pct, fat_pct, raw, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16, now())
       ON CONFLICT (delivery_diet_id, day) DO UPDATE SET
         plan_kcal=EXCLUDED.plan_kcal, kcal=EXCLUDED.kcal, kj=EXCLUDED.kj,
         protein_g=EXCLUDED.protein_g, carb_g=EXCLUDED.carb_g, fat_g=EXCLUDED.fat_g,
         saturated_fat_g=EXCLUDED.saturated_fat_g, fiber_g=EXCLUDED.fiber_g,
         sugar_g=EXCLUDED.sugar_g, salt_g=EXCLUDED.salt_g, protein_pct=EXCLUDED.protein_pct,
         carb_pct=EXCLUDED.carb_pct, fat_pct=EXCLUDED.fat_pct, raw=EXCLUDED.raw, updated_at=now()`,
      [
        deliveryDietId, day,
        agg.get('calorific_kcal_offer') ?? null, agg.get('calorific_kcal') ?? null,
        agg.get('calorific_kj') ?? null, agg.get('protein') ?? null, agg.get('carb') ?? null,
        agg.get('fat') ?? null, agg.get('saturated_fat') ?? null, agg.get('fiber') ?? null,
        agg.get('sugar') ?? null, agg.get('salt') ?? null, agg.get('protein_percent') ?? null,
        agg.get('carb_percent') ?? null, agg.get('fat_percent') ?? null,
        JSON.stringify(aggregates)
      ]
    );

    await client.query('COMMIT');
    return { products: productCount, meals: mealCount, day, no_delivery: false, warnings };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
