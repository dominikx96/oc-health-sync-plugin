import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { validateApiKey, sendUnauthorized } from '../utils/auth.js';
import { sendJson } from '../utils/http.js';
import { getSampleCount, getLastIngestTime } from '../db/queries.js';

export function registerHealthcheckRoute(
  api: PluginApi,
  db: DatabaseSync,
  apiKey: string,
): void {
  api.registerHttpRoute({
    path: '/api/v1/health',
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      if (!validateApiKey(req, apiKey)) {
        sendUnauthorized(res);
        return true;
      }

      sendJson(res, 200, {
        status: 'ok',
        plugin: 'health-sync',
        version: '0.1.0',
        samples_count: getSampleCount(db),
        last_ingest: getLastIngestTime(db),
      });
      return true;
    },
  });
}
