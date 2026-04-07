import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { sendJson } from '../utils/http.js';
import { generateSummary } from '../summary/generator.js';
import type { SummaryMode } from '../summary/generator.js';
import { executeHealthQuery } from '../tools/query.js';
import { executeAnomalyDetection } from '../tools/anomalies.js';
import { executeRawQuery } from '../tools/raw.js';
import { executeComparison } from '../tools/compare.js';

function getQueryParams(url: string | undefined): URLSearchParams {
  if (!url) return new URLSearchParams();
  const qIdx = url.indexOf('?');
  return qIdx >= 0 ? new URLSearchParams(url.slice(qIdx + 1)) : new URLSearchParams();
}

export function registerQueryRoutes(
  api: PluginApi,
  db: DatabaseSync,
  cacheTtlMinutes: number,
): void {
  // GET /api/v1/health/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
  api.registerHttpRoute({
    path: '/api/v1/health/summary',
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      const params = getQueryParams(req.url);
      const from = params.get('from');
      const to = params.get('to');

      const mode = (params.get('mode') || 'auto') as SummaryMode;

      if (!from || !to) {
        sendJson(res, 400, { error: 'bad_request', message: 'Missing required params: from, to (YYYY-MM-DD)' });
        return true;
      }

      try {
        const markdown = generateSummary(db, from, to, cacheTtlMinutes, mode);
        sendJson(res, 200, { markdown });
      } catch (err) {
        console.error('[health-sync] Summary error:', err);
        sendJson(res, 500, { error: 'internal_error', message: 'Failed to generate summary' });
      }
      return true;
    },
  });

  // GET /api/v1/health/query?metric=steps&from=YYYY-MM-DD&to=YYYY-MM-DD&aggregation=sum
  api.registerHttpRoute({
    path: '/api/v1/health/query',
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      const params = getQueryParams(req.url);
      const metric = params.get('metric');
      const from = params.get('from');
      const to = params.get('to');
      const aggregation = params.get('aggregation') || undefined;

      if (!metric || !from || !to) {
        sendJson(res, 400, { error: 'bad_request', message: 'Missing required params: metric, from, to' });
        return true;
      }

      try {
        const result = executeHealthQuery(db, { metric, from, to, aggregation });
        sendJson(res, 200, result);
      } catch (err) {
        console.error('[health-sync] Query error:', err);
        sendJson(res, 500, { error: 'internal_error', message: 'Failed to execute query' });
      }
      return true;
    },
  });

  // GET /api/v1/health/anomalies?days=14&sensitivity=medium
  api.registerHttpRoute({
    path: '/api/v1/health/anomalies',
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      const params = getQueryParams(req.url);
      const days = params.get('days') ? Number(params.get('days')) : undefined;
      const sensitivity = params.get('sensitivity') || undefined;

      try {
        const markdown = executeAnomalyDetection(db, { days, sensitivity });
        sendJson(res, 200, { markdown });
      } catch (err) {
        console.error('[health-sync] Anomalies error:', err);
        sendJson(res, 500, { error: 'internal_error', message: 'Failed to detect anomalies' });
      }
      return true;
    },
  });

  // GET /api/v1/health/raw?data_type=heart_rate&from=...&to=...&limit=100
  api.registerHttpRoute({
    path: '/api/v1/health/raw',
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      const params = getQueryParams(req.url);
      const data_type = params.get('data_type');
      const from = params.get('from');
      const to = params.get('to');
      const limit = params.get('limit') ? Number(params.get('limit')) : undefined;

      if (!data_type || !from || !to) {
        sendJson(res, 400, { error: 'bad_request', message: 'Missing required params: data_type, from, to' });
        return true;
      }

      try {
        const result = executeRawQuery(db, { data_type, from, to, limit });
        sendJson(res, 200, result);
      } catch (err) {
        console.error('[health-sync] Raw query error:', err);
        sendJson(res, 500, { error: 'internal_error', message: 'Failed to execute raw query' });
      }
      return true;
    },
  });

  // GET /api/v1/health/compare?period_a_from=...&period_a_to=...&period_b_from=...&period_b_to=...&metrics=steps,hrv
  api.registerHttpRoute({
    path: '/api/v1/health/compare',
    auth: 'plugin',
    match: 'exact',
    handler: async (req, res) => {
      const params = getQueryParams(req.url);
      const period_a_from = params.get('period_a_from');
      const period_a_to = params.get('period_a_to');
      const period_b_from = params.get('period_b_from');
      const period_b_to = params.get('period_b_to');
      const metricsParam = params.get('metrics');
      const metrics = metricsParam ? metricsParam.split(',') : undefined;

      if (!period_a_from || !period_a_to || !period_b_from || !period_b_to) {
        sendJson(res, 400, {
          error: 'bad_request',
          message: 'Missing required params: period_a_from, period_a_to, period_b_from, period_b_to',
        });
        return true;
      }

      try {
        const result = executeComparison(db, {
          period_a_from,
          period_a_to,
          period_b_from,
          period_b_to,
          metrics,
        });
        sendJson(res, 200, result);
      } catch (err) {
        console.error('[health-sync] Compare error:', err);
        sendJson(res, 500, { error: 'internal_error', message: 'Failed to execute comparison' });
      }
      return true;
    },
  });
}
