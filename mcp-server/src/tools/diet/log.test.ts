import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { logMeal, logDeviation } from './log.js';

const writePool = createPool(process.env.MCP_DIET_WRITER_URL ?? 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day, diet_products, diet_subscriptions RESTART IDENTITY CASCADE');
  await adminPool.query(`INSERT INTO diet_subscriptions (delivery_diet_id) VALUES (1)`);
  await adminPool.query(`INSERT INTO diet_products (simple_product_id, name, kcal) VALUES (10,'Breakfast',500)`);
  await adminPool.query(`INSERT INTO diet_catering_meals
    (delivery_item_id, delivery_diet_id, delivery_id, day, meal_slot_key, meal_slot_position, simple_product_id, status)
    VALUES (100, 1, 9, DATE '2026-05-18', 'BREAKFAST', 1, 10, 'REALIZED')`);
});

describe('logMeal', () => {
  it('inserts an adhoc row and is idempotent on uuid', async () => {
    const r1 = await logMeal(writePool, { uuid: 'm1', date: '2026-05-18', tz: 'UTC', name: 'Banana', kcal: 95, source: 'web_research' });
    expect(r1.id).toBeGreaterThan(0);
    const r2 = await logMeal(writePool, { uuid: 'm1', date: '2026-05-18', tz: 'UTC', name: 'Banana', kcal: 95, source: 'web_research' });
    expect(r2.id).toBe(r1.id);
    const n = await adminPool.query(`SELECT count(*)::int c FROM diet_consumption WHERE kind='adhoc'`);
    expect(n.rows[0].c).toBe(1);
  });

  it('rejects missing kcal', async () => {
    await expect(logMeal(writePool, { uuid: 'm2', name: 'X' } as any)).rejects.toThrow(/kcal/);
  });
});

describe('logDeviation', () => {
  it('resolves catering_meal_id from (day, meal_slot_key) for a partial', async () => {
    const r = await logDeviation(writePool, { uuid: 'd1', kind: 'partial', day: '2026-05-18', meal_slot_key: 'BREAKFAST', consumed_fraction: 0.5 });
    const row = await adminPool.query(`SELECT catering_meal_id, to_char(day,'YYYY-MM-DD') AS day, consumed_fraction FROM diet_consumption WHERE uuid='d1'`);
    expect(row.rows[0].catering_meal_id).not.toBeNull();
    expect(row.rows[0].day).toBe('2026-05-18');
    expect(Number(row.rows[0].consumed_fraction)).toBe(0.5);
    expect(r.id).toBeGreaterThan(0);
  });

  it('errors when the slot cannot be resolved', async () => {
    await expect(logDeviation(writePool, { uuid: 'd2', kind: 'skip', day: '2026-05-18', meal_slot_key: 'DINNER' }))
      .rejects.toThrow(/no catering meal/i);
  });

  it('partial requires consumed_fraction', async () => {
    await expect(logDeviation(writePool, { uuid: 'd3', kind: 'partial', day: '2026-05-18', meal_slot_key: 'BREAKFAST' }))
      .rejects.toThrow(/consumed_fraction/);
  });

  it('is idempotent on uuid (second call returns same id, no dup row)', async () => {
    const r1 = await logDeviation(writePool, { uuid: 'dup1', kind: 'skip', day: '2026-05-18', meal_slot_key: 'BREAKFAST' });
    const r2 = await logDeviation(writePool, { uuid: 'dup1', kind: 'skip', day: '2026-05-18', meal_slot_key: 'BREAKFAST' });
    expect(r2.id).toBe(r1.id);
    const n = await adminPool.query(`SELECT count(*)::int c FROM diet_consumption WHERE uuid='dup1'`);
    expect(n.rows[0].c).toBe(1);
  });

  it('records a swap with swap_product_id', async () => {
    const r = await logDeviation(writePool, { uuid: 'sw1', kind: 'swap', day: '2026-05-18', meal_slot_key: 'BREAKFAST', swap_product_id: 10 });
    expect(r.id).toBeGreaterThan(0);
    const row = await adminPool.query(`SELECT kind, swap_product_id, to_char(day,'YYYY-MM-DD') AS day FROM diet_consumption WHERE uuid='sw1'`);
    expect(row.rows[0].kind).toBe('swap');
    expect(Number(row.rows[0].swap_product_id)).toBe(10);
    expect(row.rows[0].day).toBe('2026-05-18');
  });
});
