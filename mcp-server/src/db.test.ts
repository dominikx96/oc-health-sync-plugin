import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from './db.js';

const DSN = process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres';
const pool = createPool(DSN);

afterAll(async () => { await pool.end(); });

describe('db pool', () => {
  it('connects and runs a SELECT', async () => {
    const r = await pool.query<{ n: number }>('SELECT 1::int AS n');
    expect(r.rows[0].n).toBe(1);
  });

  it('rejects writes against health_samples', async () => {
    await expect(pool.query("INSERT INTO health_samples (uuid, sample_kind, data_type, start_date, end_date) VALUES ('x','quantity','y',now(),now())"))
      .rejects.toThrow(/permission denied/);
  });

  it('allows writes against summary_cache', async () => {
    await pool.query("INSERT INTO summary_cache (cache_key, markdown) VALUES ('test:1', 'hi') ON CONFLICT (cache_key) DO UPDATE SET markdown = EXCLUDED.markdown");
    await pool.query("DELETE FROM summary_cache WHERE cache_key = 'test:1'");
  });
});
