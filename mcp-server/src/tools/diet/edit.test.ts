import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { updateEntry, deleteEntry } from './edit.js';

const writePool = createPool(process.env.MCP_DIET_WRITER_URL ?? 'postgresql://diet_writer_user:diet_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE diet_consumption RESTART IDENTITY CASCADE');
  await adminPool.query(`INSERT INTO diet_consumption (uuid, day, tz, kind, name, kcal, notes)
    VALUES ('a1', DATE '2026-05-18', 'UTC', 'adhoc', 'Banana', 95, 'first')`);
});

describe('updateEntry', () => {
  it('updates provided fields and preserves omitted ones', async () => {
    await updateEntry(writePool, { uuid: 'a1', kcal: 120 });
    const row = await adminPool.query(`SELECT kcal, name, notes FROM diet_consumption WHERE uuid='a1'`);
    expect(Number(row.rows[0].kcal)).toBe(120);
    expect(row.rows[0].name).toBe('Banana');   // preserved
    expect(row.rows[0].notes).toBe('first');   // preserved
  });

  it('throws when the entry is not found', async () => {
    await expect(updateEntry(writePool, { uuid: 'nope', kcal: 1 })).rejects.toThrow(/not found/);
  });
});

describe('deleteEntry', () => {
  it('soft-deletes (sets deleted_at)', async () => {
    await deleteEntry(writePool, { uuid: 'a1' });
    const row = await adminPool.query(`SELECT deleted_at FROM diet_consumption WHERE uuid='a1'`);
    expect(row.rows[0].deleted_at).not.toBeNull();
  });

  it('throws when the entry is not found', async () => {
    await expect(deleteEntry(writePool, { uuid: 'nope' })).rejects.toThrow(/not found/);
  });
});
