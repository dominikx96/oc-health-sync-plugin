import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { validateApiKey, sendUnauthorized } from '../utils/auth.js';
import { parseJsonBody, sendJson } from '../utils/http.js';
import {
  upsertSamples,
  softDeleteSamples,
  setSyncMetadata,
  invalidateSummariesForDates,
} from '../db/queries.js';
import type { IngestSample } from '../db/queries.js';
import { DATA_TYPE_MAP } from '../types/data-type-schema.js';

// Build reverse lookup: short name → full HK identifier + kind
const SHORT_TO_HK: Record<string, { identifier: string; kind: string }> = {};
for (const [shortName, def] of Object.entries(DATA_TYPE_MAP)) {
  SHORT_TO_HK[shortName] = def;
}

function normalizeDataType(dataType: string): string {
  return SHORT_TO_HK[dataType]?.identifier ?? dataType;
}

function deriveSampleKind(
  rawType: string | undefined,
  normalizedType: string,
): 'quantity' | 'category' | 'workout' {
  // Check if the raw short name has a known kind in DATA_TYPE_MAP
  if (rawType && SHORT_TO_HK[rawType]) {
    return SHORT_TO_HK[rawType].kind as 'quantity' | 'category' | 'workout';
  }
  // Fall back to inferring from the full HK identifier
  if (normalizedType.includes('HKCategoryType')) return 'category';
  if (normalizedType.includes('HKWorkoutType') || normalizedType === 'HKWorkoutTypeIdentifier') return 'workout';
  return 'quantity';
}

interface IngestRequestBody {
  device_id: string;
  data_type?: string;
  new_samples: IngestSample[];
  deleted_ids?: string[];
}

function extractAffectedDates(
  samples: IngestSample[],
  deletedIds: string[],
  db: DatabaseSync,
): string[] {
  const dates = new Set<string>();

  for (const s of samples) {
    const d = s.start_date.slice(0, 10);
    dates.add(d);
  }

  // For deleted samples, we'd need to look up their dates.
  // Since we're soft-deleting, the cache invalidation covers
  // any date that had a sample modified.
  if (deletedIds.length > 0) {
    const placeholders = deletedIds.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT DISTINCT date(start_date) as d FROM health_samples WHERE uuid IN (${placeholders})`,
      )
      .all(...deletedIds) as unknown as Array<{ d: string }>;
    for (const row of rows) {
      dates.add(row.d);
    }
  }

  return Array.from(dates);
}

export function registerIngestRoute(
  api: PluginApi,
  db: DatabaseSync,
  apiKey: string,
): void {
  api.registerHttpRoute({
    path: '/api/v1/health/ingest',
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      if (!validateApiKey(req, apiKey)) {
        sendUnauthorized(res);
        return true;
      }

      let body: IngestRequestBody;
      try {
        body = await parseJsonBody<IngestRequestBody>(req);
      } catch (err) {
        sendJson(res, 400, {
          error: 'bad_request',
          message: err instanceof Error ? err.message : 'Invalid request body',
        });
        return true;
      }

      if (!body.device_id || !Array.isArray(body.new_samples)) {
        sendJson(res, 400, {
          error: 'bad_request',
          message: 'Missing required fields: device_id, new_samples',
        });
        return true;
      }

      const newSamples = body.new_samples.map((s) => {
        const rawType = s.data_type ?? body.data_type ?? 'unknown';
        const dataType = normalizeDataType(rawType);
        return {
          ...s,
          data_type: dataType,
          sample_kind: s.sample_kind ?? deriveSampleKind(rawType, dataType),
        };
      });
      const deletedIds = body.deleted_ids ?? [];

      console.log(`[health-sync] 📥 Ingest request from device ${body.device_id}: ${newSamples.length} samples, ${deletedIds.length} deletes`);

      try {
        const affectedDates = extractAffectedDates(newSamples, deletedIds, db);

        const received = upsertSamples(db, body.device_id, newSamples);
        const deleted = softDeleteSamples(db, deletedIds);
        const result = { received, deleted };

        invalidateSummariesForDates(db, affectedDates);

        const now = new Date().toISOString();
        setSyncMetadata(db, 'last_ingest_at', now);

        // Log summary of received data
        const typeCounts = new Map<string, number>();
        for (const s of newSamples) {
          typeCounts.set(s.data_type, (typeCounts.get(s.data_type) ?? 0) + 1);
        }
        const typeBreakdown = Array.from(typeCounts.entries())
          .map(([type, count]) => {
            const short = type.replace(/^HK(Quantity|Category)TypeIdentifier/, '');
            return `${short}: ${count}`;
          })
          .join(', ');

        console.log(`[health-sync] ✅ Stored ${result.received} samples, soft-deleted ${result.deleted} | Dates: ${affectedDates.join(', ')} | ${typeBreakdown}`);

        sendJson(res, 200, {
          received: result.received,
          deleted: result.deleted,
          timestamp: now,
        });
      } catch (err) {
        console.error('[health-sync] Ingest error:', err);
        sendJson(res, 500, {
          error: 'internal_error',
          message: 'Failed to process ingest request',
        });
      }

      return true;
    },
  });
}
