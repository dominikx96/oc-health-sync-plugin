import type Database from 'better-sqlite3';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import type { PluginConfig } from '../utils/config.js';
import { registerSummaryTool } from './summary.js';
import { registerQueryTool } from './query.js';
import { registerAnomaliesTool } from './anomalies.js';
import { registerRawTool } from './raw.js';

export function registerHealthTools(
  api: PluginApi,
  db: Database.Database,
  config: PluginConfig,
): void {
  registerSummaryTool(api, db, config.summaryCacheTtlMinutes);
  registerQueryTool(api, db);
  registerAnomaliesTool(api, db);
  registerRawTool(api, db);
}
