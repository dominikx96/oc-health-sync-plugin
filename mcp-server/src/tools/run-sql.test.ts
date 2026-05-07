import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from '../db.js';
import { runSql } from './run-sql.js';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
afterAll(async () => { await pool.end(); });

describe('runSql', () => {
  it('returns rows for a SELECT', async () => {
    const r = await runSql(pool, { query: 'SELECT 1::int AS n, \'hi\'::text AS msg' });
    expect(r.rows).toEqual([{ n: 1, msg: 'hi' }]);
  });

  it('rejects multi-statement queries', async () => {
    await expect(runSql(pool, { query: 'SELECT 1; SELECT 2' })).rejects.toThrow(/single statement/i);
  });

  it('surfaces postgres errors', async () => {
    await expect(runSql(pool, { query: 'SELECT * FROM nonexistent_table' })).rejects.toThrow(/does not exist/);
  });

  it('blocks writes against health_samples (transaction read-only OR role-grant)', async () => {
    // BEGIN READ ONLY fires "cannot execute INSERT in a read-only transaction" before
    // role grants are checked, so the error message we see depends on which layer
    // catches the write first. Either is an acceptable signal that writes are blocked.
    await expect(runSql(pool, {
      query: "INSERT INTO health_samples (uuid, sample_kind, data_type, start_date, end_date) VALUES ('x', 'quantity', 'y', now(), now())"
    })).rejects.toThrow(/permission denied|read-only transaction/i);
  });

  it('aborts on a slow query (statement timeout)', async () => {
    await expect(runSql(pool, { query: 'SELECT pg_sleep(10)' })).rejects.toThrow(/canceling statement|timeout/i);
  }, 10_000);
});
