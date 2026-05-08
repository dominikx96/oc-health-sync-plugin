import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../db.js';
import { healthAnomalies } from './health-anomalies.js';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
afterAll(async () => { await pool.end(); });

beforeEach(async () => {
  // fixtures handled by the test below
});

describe('healthAnomalies', () => {
  it('returns markdown with no anomalies on empty DB', async () => {
    // we cannot truncate as read_user. Use an admin connection just for setup.
    const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');
    await adminPool.query('TRUNCATE health_samples');
    await adminPool.end();

    const result = await healthAnomalies(pool, { window_days: 30 });
    expect(result).toMatch(/no anomalies/i);
  });

  it('reports a sleep_deficit anomaly', async () => {
    const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');
    await adminPool.query('TRUNCATE health_samples');
    for (let i = 0; i < 30; i++) {
      const start = new Date(`2026-04-01T22:00:00Z`);
      start.setUTCDate(start.getUTCDate() + i);
      const end = new Date(start);
      end.setUTCHours(end.getUTCHours() + (i >= 27 ? 4 : 7));
      await adminPool.query(
        `INSERT INTO health_samples (uuid, sample_kind, data_type, value, unit, start_date, end_date)
         VALUES ($1, 'category', 'HKCategoryTypeIdentifierSleepAnalysis', 1, NULL, $2, $3)`,
        [`sleep-${i}`, start.toISOString(), end.toISOString()]
      );
    }
    await adminPool.end();

    const result = await healthAnomalies(pool, { window_days: 60 });
    expect(result).toMatch(/sleep_deficit/);
  });
});
