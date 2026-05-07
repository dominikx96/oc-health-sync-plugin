import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { IngestPayloadSchema } from './schema.ts';

Deno.test('parses a minimal valid payload', () => {
  const result = IngestPayloadSchema.safeParse({
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
  assert(result.success, JSON.stringify(result));
});

Deno.test('rejects an invalid sample_kind', () => {
  const result = IngestPayloadSchema.safeParse({
    device_id: 'dev1',
    new_samples: [{
      uuid: 'u1',
      sample_kind: 'bogus',
      data_type: 'HKX',
      value: 1,
      unit: 'x',
      start_date: '2026-04-01T10:00:00Z',
      end_date:   '2026-04-01T10:00:00Z',
      source_name: 'iPhone'
    }],
    deleted_ids: []
  });
  assertEquals(result.success, false);
});

Deno.test('rejects a non-ISO date', () => {
  const result = IngestPayloadSchema.safeParse({
    device_id: 'dev1',
    new_samples: [{
      uuid: 'u1',
      sample_kind: 'quantity',
      data_type: 'HKX',
      value: 1,
      unit: 'x',
      start_date: 'not-a-date',
      end_date:   '2026-04-01T10:00:00Z',
      source_name: 'iPhone'
    }],
    deleted_ids: []
  });
  assertEquals(result.success, false);
});
