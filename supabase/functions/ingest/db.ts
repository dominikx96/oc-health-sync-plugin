import postgres from 'npm:postgres@3.4.4';

export type Sql = ReturnType<typeof postgres>;

export function makeSql(): Sql {
  const dsn = Deno.env.get('INGEST_DATABASE_URL');
  if (!dsn) throw new Error('INGEST_DATABASE_URL is not set');
  return postgres(dsn, { max: 4, prepare: false });
}
