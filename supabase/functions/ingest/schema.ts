import { z } from 'npm:zod@^4.0.0';

const IsoDate = z.string().refine(
  (s) => !Number.isNaN(Date.parse(s)),
  { message: 'not a valid ISO date' }
);

export const SampleSchema = z.object({
  uuid:        z.string().min(1),
  sample_kind: z.enum(['quantity', 'category', 'workout']),
  data_type:   z.string().min(1),
  value:       z.number().nullable().optional(),
  unit:        z.string().nullable().optional(),
  start_date:  IsoDate,
  end_date:    IsoDate,
  source_name: z.string().nullable().optional(),
  metadata:    z.record(z.string(), z.unknown()).nullable().optional()
});

export const IngestPayloadSchema = z.object({
  device_id:    z.string().min(1),
  new_samples:  z.array(SampleSchema),
  deleted_ids:  z.array(z.string().min(1))
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;
export type Sample        = z.infer<typeof SampleSchema>;
