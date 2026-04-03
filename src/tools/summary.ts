import { Type } from '@sinclair/typebox';
import type Database from 'better-sqlite3';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { generateSummary } from '../summary/generator.js';

export function registerSummaryTool(
  api: PluginApi,
  db: Database.Database,
  cacheTtlMinutes: number,
): void {
  api.registerTool({
    name: 'health_summary',
    description:
      'Get a daily, weekly, or monthly health summary with activity, workouts, vitals, sleep, and notable trends. Use for broad health questions like "How was my health this week?" or "Summarize yesterday".',
    parameters: Type.Object({
      from: Type.String({ description: 'Start date (ISO format: YYYY-MM-DD)' }),
      to: Type.String({ description: 'End date (ISO format: YYYY-MM-DD)' }),
      type: Type.Optional(
        Type.Union([
          Type.Literal('daily'),
          Type.Literal('weekly'),
          Type.Literal('monthly'),
        ]),
      ),
    }),
    execute(_id, params) {
      const { from, to } = params as { from: string; to: string };
      const markdown = generateSummary(db, from, to, cacheTtlMinutes);
      return { content: [{ type: 'text' as const, text: markdown }] };
    },
  });
}
