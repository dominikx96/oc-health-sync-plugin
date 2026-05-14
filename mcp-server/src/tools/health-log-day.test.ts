import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../db.js';
import { healthLogDay } from './health-log-day.js';

const writePool = createPool(process.env.MCP_GYM_WRITER_URL ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE daily_logs');
});

describe('healthLogDay', () => {
  it('inserts a fresh row with the given date and fields', async () => {
    const r = await healthLogDay(writePool, {
      date: '2026-05-14', tz: 'Europe/Warsaw', alcohol: true, notes: 'urodziny'
    });
    expect(r.day).toBe('2026-05-14');
    expect(r.tz).toBe('Europe/Warsaw');
    expect(r.alcohol).toBe(true);
    expect(r.notes).toBe('urodziny');
  });

  it('defaults date to "today in tz" when date is omitted', async () => {
    const r = await healthLogDay(writePool, { tz: 'UTC', alcohol: false });
    expect(r.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(r.alcohol).toBe(false);
  });

  it('defaults tz to UTC when tz is omitted', async () => {
    const r = await healthLogDay(writePool, { date: '2026-05-14', alcohol: true });
    expect(r.tz).toBe('UTC');
  });

  it('upserts on (day): second call updates supplied fields, preserves others via COALESCE', async () => {
    await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', alcohol: true, notes: 'first note' });
    // Second call: only set notes; alcohol should stay true.
    const r2 = await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', notes: 'second note' });
    expect(r2.alcohol).toBe(true);          // preserved
    expect(r2.notes).toBe('second note');   // updated

    // Third call: only set alcohol; notes should stay 'second note'.
    const r3 = await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', alcohol: false });
    expect(r3.alcohol).toBe(false);
    expect(r3.notes).toBe('second note');
  });

  it('produces exactly one row per day after multiple upserts', async () => {
    await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', alcohol: true });
    await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', alcohol: false });
    await healthLogDay(writePool, { date: '2026-05-14', tz: 'UTC', notes: 'x' });
    const c = await adminPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM daily_logs WHERE day = '2026-05-14'`
    );
    expect(c.rows[0].count).toBe('1');
  });
});
