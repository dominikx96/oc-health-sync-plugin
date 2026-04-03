import { Type } from '@sinclair/typebox';
import type Database from 'better-sqlite3';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { getSamplesInRange } from '../db/queries.js';
import { METRIC_MAP } from '../utils/constants.js';

export function registerRawTool(
  api: PluginApi,
  db: Database.Database,
): void {
  api.registerTool({
    name: 'health_raw',
    description:
      'Access raw health samples. Use as a last resort when health_summary and health_query do not provide enough detail. Can return large datasets.',
    parameters: Type.Object({
      data_type: Type.String({
        description:
          'HK type identifier (e.g. "HKQuantityTypeIdentifierHeartRate") or short name (e.g. "heart_rate")',
      }),
      from: Type.String({ description: 'Start datetime (ISO format)' }),
      to: Type.String({ description: 'End datetime (ISO format)' }),
      limit: Type.Optional(
        Type.Number({
          description: 'Max samples to return (default: 100, max: 500)',
          default: 100,
        }),
      ),
    }),
    execute(_id, params) {
      const {
        data_type,
        from,
        to,
        limit = 100,
      } = params as {
        data_type: string;
        from: string;
        to: string;
        limit?: number;
      };

      // Resolve short name to full HK identifier
      const def = METRIC_MAP[data_type];
      const resolvedType = def ? def.dataType : data_type;

      const clampedLimit = Math.min(Math.max(1, limit), 500);
      const samples = getSamplesInRange(db, resolvedType, from, to, clampedLimit);

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              {
                data_type: resolvedType,
                from,
                to,
                count: samples.length,
                limit: clampedLimit,
                samples,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  });
}
