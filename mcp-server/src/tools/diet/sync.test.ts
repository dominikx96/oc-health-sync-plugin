import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../db.js';
import { syncSubscriptions, syncCateringDay } from './sync.js';

const writePool = createPool(process.env.MCP_DIET_WRITER_URL ?? 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

const fx = (n: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../test/fixtures/${n}`, import.meta.url)), 'utf8'));

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day, diet_products, diet_subscriptions RESTART IDENTITY CASCADE');
});

describe('syncSubscriptions', () => {
  it('upserts a subscription and is idempotent', async () => {
    const r1 = await syncSubscriptions(writePool, fx('ntfy-delivery-diets.json'));
    expect(r1.upserted).toBeGreaterThan(0);
    const r2 = await syncSubscriptions(writePool, fx('ntfy-delivery-diets.json'));
    expect(r2.upserted).toBe(r1.upserted);
    const row = await adminPool.query(`SELECT user_diet_name, plan_kcal FROM diet_subscriptions WHERE delivery_diet_id = 2070357`);
    expect(row.rows[0].user_diet_name).toBe('Domino');
    expect(row.rows[0].plan_kcal).toBe(2000);
  });
});

describe('syncCateringDay', () => {
  it('parses the deliveries payload into products/meals/day', async () => {
    const r = await syncCateringDay(writePool, fx('ntfy-deliveries.json'));
    expect(r.no_delivery).toBe(false);
    expect(r.products).toBe(45);
    expect(r.meals).toBe(5);
    const meals = await adminPool.query(`SELECT meal_slot_key, simple_product_id FROM diet_catering_meals ORDER BY meal_slot_position`);
    expect(meals.rows).toHaveLength(5);
    expect(meals.rows[0].meal_slot_key).toBe('BREAKFAST');
    const day = await adminPool.query(`SELECT plan_kcal, kcal, protein_g FROM diet_catering_day WHERE day = DATE '2026-05-18'`);
    expect(Number(day.rows[0].plan_kcal)).toBe(2000);
    expect(Number(day.rows[0].kcal)).toBe(1923);
    expect(Number(day.rows[0].protein_g)).toBeCloseTo(103.7, 1);
  });

  it('is idempotent (no duplicate meals on re-run)', async () => {
    await syncCateringDay(writePool, fx('ntfy-deliveries.json'));
    await syncCateringDay(writePool, fx('ntfy-deliveries.json'));
    const n = await adminPool.query(`SELECT count(*)::int AS c FROM diet_catering_meals`);
    expect(n.rows[0].c).toBe(5);
  });

  it('no-ops on an empty (no-delivery) payload', async () => {
    const r = await syncCateringDay(writePool, { data: { result_count: 0, results: [], includes: {}, aggregates: [] } });
    expect(r).toEqual({ products: 0, meals: 0, day: null, no_delivery: true, warnings: [] });
  });

  it('stubs a missing product and reports a warning', async () => {
    const p = fx('ntfy-deliveries.json');
    p.data.includes.simple_products = p.data.includes.simple_products.filter((sp: any) => sp.id !== p.data.includes.delivery_items[0].simple_product_id);
    const r = await syncCateringDay(writePool, p);
    expect(r.warnings.length).toBeGreaterThan(0);
    const stub = await adminPool.query(`SELECT name, kcal FROM diet_products WHERE simple_product_id = $1`, [p.data.includes.delivery_items[0].simple_product_id]);
    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0].kcal).toBeNull();
  });

  it('does not fail when a product has no name (NOT NULL fallback)', async () => {
    const p = fx('ntfy-deliveries.json');
    delete p.data.includes.simple_products[0].name;
    const r = await syncCateringDay(writePool, p);
    expect(r.no_delivery).toBe(false);
    const stub = await adminPool.query(
      `SELECT name FROM diet_products WHERE simple_product_id = $1`,
      [p.data.includes.simple_products[0].id]
    );
    expect(stub.rows[0].name).toBe(`product ${p.data.includes.simple_products[0].id}`);
  });
});
