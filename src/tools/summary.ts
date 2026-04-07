import { Type } from '@sinclair/typebox';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { generateSummary } from '../summary/generator.js';
import type { SummaryMode } from '../summary/generator.js';

export function registerSummaryTool(
  api: PluginApi,
  db: DatabaseSync,
  cacheTtlMinutes: number,
): void {
  api.registerTool({
    name: 'health_summary',
    description:
      'Get a health summary with activity, workouts, vitals, sleep, and notable trends. Modes: "auto" (rollup for >3 days, daily otherwise), "rollup" (aggregate totals/averages), "daily" (per-day breakdown). Use for broad health questions.',
    parameters: Type.Object({
      from: Type.String({ description: 'Start date (ISO format: YYYY-MM-DD)' }),
      to: Type.String({ description: 'End date (ISO format: YYYY-MM-DD)' }),
      mode: Type.Optional(
        Type.Union([
          Type.Literal('auto'),
          Type.Literal('rollup'),
          Type.Literal('daily'),
        ]),
      ),
    }),
    execute(_id, params) {
      const { from, to, mode } = params as { from: string; to: string; mode?: SummaryMode };
      const markdown = generateSummary(db, from, to, cacheTtlMinutes, mode);
      return { content: [{ type: 'text' as const, text: markdown }] };
    },
  });
}
