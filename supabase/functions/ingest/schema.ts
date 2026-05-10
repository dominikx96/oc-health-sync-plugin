import { z } from 'npm:zod@^4.0.0';

const IsoDate = z.string().refine(
  (s) => !Number.isNaN(Date.parse(s)),
  { message: 'not a valid ISO date' }
);

const BaseSample = {
  uuid:        z.string().min(1),
  data_type:   z.string().min(1),
  start_date:  IsoDate,
  end_date:    IsoDate,
  source_name: z.string().nullable().optional(),
  metadata:    z.record(z.string(), z.unknown()).nullable().optional()
};

const QuantitySchema = z.object({
  ...BaseSample,
  sample_kind: z.literal('quantity'),
  value:       z.number(),
  unit:        z.string()
});

const CategorySchema = z.object({
  ...BaseSample,
  sample_kind: z.literal('category'),
  value:       z.number(),
  unit:        z.string()
});

const WorkoutSchema = z.object({
  ...BaseSample,
  sample_kind:              z.literal('workout'),
  workout_activity_name:    z.string(),
  workout_activity_type_id: z.number().int(),
  workout_duration:         z.number(),
  workout_energy:           z.number().nullable().optional(),
  workout_distance:         z.number().nullable().optional()
});

export const SampleSchema = z.discriminatedUnion('sample_kind', [
  QuantitySchema,
  CategorySchema,
  WorkoutSchema
]);

export const IngestPayloadSchema = z.object({
  device_id:    z.string().min(1),
  new_samples:  z.array(SampleSchema),
  deleted_ids:  z.array(z.string().min(1))
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
export type Sample        = z.infer<typeof SampleSchema>;
