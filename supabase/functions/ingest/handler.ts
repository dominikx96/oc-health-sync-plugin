import postgres from 'npm:postgres@3.4.4';
import type { Sql } from './db.ts';
import type { IngestPayload, Sample } from './schema.ts';

export interface IngestResult {
  stored:  number;
  deleted: number;
}

export async function handleIngest(sql: Sql, payload: IngestPayload): Promise<IngestResult> {
  const { device_id, new_samples, deleted_ids } = payload;

  let stored = 0;
  let deleted = 0;
  const touchedDays = new Set<string>();

  await sql.begin(async (tx) => {
    if (new_samples.length > 0) {
      const rows = new_samples.map((s: Sample) => ({
        uuid:        s.uuid,
        sample_kind: s.sample_kind,
        data_type:   s.data_type,
        value:       s.value ?? null,
        unit:        s.unit ?? null,
        start_date:  s.start_date,
        end_date:    s.end_date,
        source_name: s.source_name ?? null,
        metadata:    s.metadata ?? null,
        device_id:   device_id
      }));

      // postgres-js Helper variance: cast rows to the shape expected by the insert helper overload.
      type InsertRow = Record<string, postgres.ParameterOrJSON<never> | undefined>;
      const typedRows = rows as unknown as InsertRow[];
      const result = await tx`
        INSERT INTO health_samples ${ tx(typedRows, 'uuid', 'sample_kind', 'data_type', 'value', 'unit', 'start_date', 'end_date', 'source_name', 'metadata', 'device_id') }
        ON CONFLICT (uuid) DO UPDATE SET
          value       = EXCLUDED.value,
          unit        = EXCLUDED.unit,
          start_date  = EXCLUDED.start_date,
          end_date    = EXCLUDED.end_date,
          source_name = EXCLUDED.source_name,
          metadata    = EXCLUDED.metadata,
          deleted_at  = NULL
      `;
      stored = result.count;

      for (const s of new_samples) {
        const day = s.start_date.slice(0, 10);
        touchedDays.add(day);
      }
    }

    if (deleted_ids.length > 0) {
      const result = await tx`
        UPDATE health_samples
           SET deleted_at = now()
         WHERE uuid = ANY(${deleted_ids})
           AND deleted_at IS NULL
      `;
      deleted = result.count;
    }

    if (touchedDays.size > 0) {
      const days = Array.from(touchedDays);
      await tx`
        UPDATE summary_cache
           SET invalidated = true
         WHERE cache_key LIKE ANY(${days.map((d) => `daily:${d}:%`)})
            OR cache_key LIKE ANY(${days.map((d) => `weekly:${d.slice(0, 7)}%:%`)})
            OR cache_key LIKE ANY(${days.map((d) => `monthly:${d.slice(0, 7)}:%`)})
      `;
    }

    await tx`
      INSERT INTO device_state (device_id, last_synced_at, last_anchor)
      VALUES (${device_id}, now(), null)
      ON CONFLICT (device_id) DO UPDATE SET
        last_synced_at = EXCLUDED.last_synced_at
    `;
  });

  return { stored, deleted };
}
