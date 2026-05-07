import type { Pool } from '../db.js';

export interface RunSqlInput {
  query: string;
}

export interface RunSqlResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

const STATEMENT_TIMEOUT_MS = 5_000;

export async function runSql(pool: Pool, input: RunSqlInput): Promise<RunSqlResult> {
  const trimmed = input.query.trim().replace(/;\s*$/, '');
  if (trimmed.includes(';')) {
    throw new Error('runSql accepts only a single statement');
  }
  if (trimmed.length === 0) {
    throw new Error('query is empty');
  }

  const client = await pool.connect();
  try {
    // Defense in depth: read-only at the transaction layer AND role grants.
    // Either alone is sufficient; keeping both means a misconfigured role
    // wouldn't silently allow writes through this tool.
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    try {
      const r = await client.query(trimmed);
      await client.query('COMMIT');
      return {
        rows: r.rows as Record<string, unknown>[],
        rowCount: r.rowCount ?? 0
      };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
  } finally {
    client.release();
  }
}
