import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { addNote } from './notes.js';

const writePool = createPool(process.env.MCP_DIET_WRITER_URL ?? 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE diet_consumption, diet_catering_meals, diet_catering_day, diet_products, diet_subscriptions, daily_logs RESTART IDENTITY CASCADE');
  await adminPool.query(`INSERT INTO diet_subscriptions (delivery_diet_id) VALUES (1)`);
  await adminPool.query(`INSERT INTO diet_products (simple_product_id, name) VALUES (10,'B')`);
  await adminPool.query(`INSERT INTO diet_catering_meals
    (delivery_item_id, delivery_diet_id, delivery_id, day, meal_slot_key, meal_slot_position, simple_product_id, status)
    VALUES (100, 1, 9, DATE '2026-05-18', 'BREAKFAST', 1, 10, 'REALIZED')`);
  await adminPool.query(`INSERT INTO diet_consumption (uuid, day, tz, kind, name, kcal)
    VALUES ('e1', DATE '2026-05-18', 'UTC', 'adhoc', 'X', 1)`);
});

describe('addNote', () => {
  it('scope=day appends to daily_logs.notes (insert then append)', async () => {
    await addNote(writePool, { scope: 'day', text: 'line1', day: '2026-05-18', tz: 'UTC' });
    await addNote(writePool, { scope: 'day', text: 'line2', day: '2026-05-18', tz: 'UTC' });
    const row = await adminPool.query(`SELECT notes FROM daily_logs WHERE day = DATE '2026-05-18'`);
    expect(row.rows[0].notes).toBe('line1\nline2');
  });

  it('scope=entry appends to diet_consumption.notes', async () => {
    await addNote(writePool, { scope: 'entry', uuid: 'e1', text: 'first' });
    await addNote(writePool, { scope: 'entry', uuid: 'e1', text: 'second' });
    const row = await adminPool.query(`SELECT notes FROM diet_consumption WHERE uuid='e1'`);
    expect(row.rows[0].notes).toBe('first\nsecond');
  });

  it('scope=meal creates a note row against the catering meal', async () => {
    await addNote(writePool, { scope: 'meal', day: '2026-05-18', meal_slot_key: 'BREAKFAST', text: 'ate as-is, great' });
    const row = await adminPool.query(`SELECT kind, notes, catering_meal_id FROM diet_consumption WHERE kind='note'`);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].notes).toBe('ate as-is, great');
    expect(row.rows[0].catering_meal_id).not.toBeNull();
  });

  it('scope=entry throws when target not found', async () => {
    await expect(addNote(writePool, { scope: 'entry', uuid: 'nope', text: 'x' })).rejects.toThrow(/not found/);
  });
});
