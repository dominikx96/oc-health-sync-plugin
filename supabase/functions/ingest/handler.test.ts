import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import postgres from 'npm:postgres@3.4.4';
import { handleIngest } from './handler.ts';

const DSN = 'postgresql://ingest_user:ingest_pw@127.0.0.1:54422/postgres';

async function withSql(fn: (sql: ReturnType<typeof postgres>) => Promise<void>) {
  const sql = postgres(DSN, { max: 2 });
  try {
    await sql`TRUNCATE health_samples, device_state, summary_cache`;
    await fn(sql);
  } finally {
    await sql.end({ timeout: 1 });
  }
}

Deno.test('inserts new samples', async () => {
  await withSql(async (sql) => {
    const result = await handleIngest(sql, {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'u1',
        sample_kind: 'quantity',
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 100,
        unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    });
    assertEquals(result.received, 1);
    assertEquals(result.deleted, 0);

    const rows = await sql`SELECT count(*)::int AS n FROM health_samples`;
    assertEquals(rows[0].n, 1);
  });
});

Deno.test('upsert is idempotent', async () => {
  await withSql(async (sql) => {
    const payload = {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'u1', sample_kind: 'quantity' as const,
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 100, unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    };
    await handleIngest(sql, payload);
    await handleIngest(sql, payload);

    const rows = await sql`SELECT count(*)::int AS n FROM health_samples`;
    assertEquals(rows[0].n, 1);
  });
});

Deno.test('soft-deletes by uuid', async () => {
  await withSql(async (sql) => {
    await handleIngest(sql, {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'u1', sample_kind: 'quantity',
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 100, unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    });

    const result = await handleIngest(sql, {
      device_id: 'dev1',
      new_samples: [],
      deleted_ids: ['u1']
    });
    assertEquals(result.deleted, 1);

    const rows = await sql`SELECT deleted_at FROM health_samples WHERE uuid = 'u1'`;
    assertEquals(rows[0].deleted_at !== null, true);
  });
});

Deno.test('updates device_state', async () => {
  await withSql(async (sql) => {
    await handleIngest(sql, {
      device_id: 'devXYZ',
      new_samples: [],
      deleted_ids: []
    });
    const rows = await sql`SELECT * FROM device_state WHERE device_id = 'devXYZ'`;
    assertEquals(rows.length, 1);
    assertEquals(rows[0].last_synced_at !== null, true);
  });
});

Deno.test('marks summary_cache rows for affected dates as invalidated', async () => {
  // 2026-04-01 is a Wednesday; the ISO Monday of that week is 2026-03-30.
  // We seed one cache row per (period, expected-invalidate) state and assert
  // both the daily, weekly, and monthly LIKE patterns hit the right rows.
  await withSql(async (sql) => {
    await sql`
      INSERT INTO summary_cache (cache_key, markdown) VALUES
        ('daily:2026-04-01:UTC',   'old'),
        ('daily:2026-05-01:UTC',   'untouched'),
        ('weekly:2026-03-30:UTC',  'old-week'),
        ('weekly:2026-04-06:UTC',  'untouched-week'),
        ('monthly:2026-04:UTC',    'old-month'),
        ('monthly:2026-05:UTC',    'untouched-month')
    `;
    await handleIngest(sql, {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'u1', sample_kind: 'quantity',
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 100, unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    });
    const rows = await sql`SELECT cache_key, invalidated FROM summary_cache ORDER BY cache_key`;
    const byKey: Record<string, boolean> = {};
    for (const r of rows) {
      byKey[r.cache_key as string] = r.invalidated as boolean;
    }

    // Touched
    assertEquals(byKey['daily:2026-04-01:UTC'],  true);
    assertEquals(byKey['weekly:2026-03-30:UTC'], true);
    assertEquals(byKey['monthly:2026-04:UTC'],   true);

    // Untouched
    assertEquals(byKey['daily:2026-05-01:UTC'],  false);
    assertEquals(byKey['weekly:2026-04-06:UTC'], false);
    assertEquals(byKey['monthly:2026-05:UTC'],   false);
  });
});
