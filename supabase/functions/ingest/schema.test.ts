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

Deno.test('parses a valid workout sample', () => {
  const result = IngestPayloadSchema.safeParse({
    device_id: 'dev1',
    new_samples: [{
      uuid: 'w1',
      sample_kind: 'workout',
      data_type: 'HKWorkoutTypeIdentifier',
      workout_activity_name: 'cycling',
      workout_activity_type_id: 13,
      workout_duration: 1834.2,
      workout_energy: 312.5,
      workout_distance: 4820.7,
      start_date: '2026-04-01T07:00:00Z',
      end_date:   '2026-04-01T07:30:00Z',
      source_name: 'Apple Watch'
    }],
    deleted_ids: []
  });
  assert(result.success, JSON.stringify(result));
});

Deno.test('parses a workout sample with null energy/distance', () => {
  const result = IngestPayloadSchema.safeParse({
    device_id: 'dev1',
    new_samples: [{
      uuid: 'w2',
      sample_kind: 'workout',
      data_type: 'HKWorkoutTypeIdentifier',
      workout_activity_name: 'yoga',
      workout_activity_type_id: 57,
      workout_duration: 1200,
      workout_energy: null,
      workout_distance: null,
      start_date: '2026-04-01T07:00:00Z',
      end_date:   '2026-04-01T07:20:00Z'
    }],
    deleted_ids: []
  });
  assert(result.success, JSON.stringify(result));
});

Deno.test('rejects a workout sample missing workout_activity_type_id', () => {
  const result = IngestPayloadSchema.safeParse({
    device_id: 'dev1',
    new_samples: [{
      uuid: 'w3',
      sample_kind: 'workout',
      data_type: 'HKWorkoutTypeIdentifier',
      workout_activity_name: 'cycling',
      workout_duration: 1200,
      start_date: '2026-04-01T07:00:00Z',
      end_date:   '2026-04-01T07:20:00Z'
    }],
    deleted_ids: []
  });
  assertEquals(result.success, false);
});
