import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import type { PluginConfig } from '../utils/config.js';
import { registerSummaryTool } from './summary.js';
import { registerQueryTool } from './query.js';
import { registerAnomaliesTool } from './anomalies.js';
import { registerRawTool } from './raw.js';
import { registerCompareTool } from './compare.js';

export function registerHealthTools(
  api: PluginApi,
  db: DatabaseSync,
  config: PluginConfig,
): void {
  registerSummaryTool(api, db, config.summaryCacheTtlMinutes);
  registerQueryTool(api, db);
  registerAnomaliesTool(api, db);
  registerRawTool(api, db);
  registerCompareTool(api, db);
}
