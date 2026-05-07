import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from '../db.js';
import { describeSchema } from './schema.js';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
afterAll(async () => { await pool.end(); });

describe('describeSchema', () => {
  it('lists known tables, views/functions, and example queries', async () => {
    const md = await describeSchema(pool);
    expect(md).toMatch(/health_samples/);
    expect(md).toMatch(/device_state/);
    expect(md).toMatch(/summary_cache/);
    expect(md).toMatch(/daily_metrics\(/);
    expect(md).toMatch(/detect_anomalies\(/);
    expect(md).toMatch(/example/i);
  });
});
