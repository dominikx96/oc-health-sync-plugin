import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../db.js';
import { healthSummary } from './health-summary.js';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');
afterAll(async () => { await pool.end(); await adminPool.end(); });

beforeEach(async () => {
  await adminPool.query('TRUNCATE health_samples, summary_cache');
});

describe('healthSummary', () => {
  it('renders a daily summary from data', async () => {
    await adminPool.query(
      `INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
       VALUES
         ('a', 'quantity', 'HKQuantityTypeIdentifierStepCount', 8000, 'count', '2026-04-01T10:00:00Z', '2026-04-01T10:30:00Z'),
         ('b', 'quantity', 'HKQuantityTypeIdentifierHeartRate',   72, 'count/min', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
    );
    const md = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    expect(md).toMatch(/2026-04-01/);
    expect(md).toMatch(/8[,\s]?000/);   // step count formatted, allow comma
    expect(md).toMatch(/72/);
  });

  it('returns "no data" markdown when no samples in range', async () => {
    const md = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    expect(md).toMatch(/no data/i);
  });

  it('reads from cache on the second call', async () => {
    await adminPool.query(
      `INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
       VALUES ('a', 'quantity', 'HKQuantityTypeIdentifierStepCount', 1, 'count', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
    );
    const first  = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    // Mutate underlying data; the cached output should still be returned.
    await adminPool.query("UPDATE health_samples SET value = 999 WHERE uuid = 'a'");
    const second = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    expect(second).toBe(first);
  });

  it('regenerates when cache is invalidated', async () => {
    await adminPool.query(
      `INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
       VALUES ('a', 'quantity', 'HKQuantityTypeIdentifierStepCount', 1, 'count', '2026-04-01T10:00:00Z', '2026-04-01T10:00:00Z')`
    );
    const first = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    await adminPool.query("UPDATE summary_cache SET invalidated = true");
    await adminPool.query("UPDATE health_samples SET value = 12345 WHERE uuid = 'a'");
    const second = await healthSummary(pool, { period: 'day', date: '2026-04-01', tz: 'UTC' });
    expect(second).not.toBe(first);
    expect(second).toMatch(/12[,\s]?345/);
  });
});
