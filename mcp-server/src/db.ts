import pg from 'pg';

export type Pool = pg.Pool;

export function createPool(dsn: string): pg.Pool {
  return new pg.Pool({
    connectionString: dsn,
    max: 8,
    idleTimeoutMillis: 30_000
  });
}
