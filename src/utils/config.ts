import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { PluginApi } from 'openclaw/plugin-sdk/core';
import { getSyncMetadata, setSyncMetadata } from '../db/queries.js';

export interface PluginConfig {
  apiKey: string;
  storagePath: string;
  summaryCacheTtlMinutes: number;
  timezone: string;
}

const DEFAULT_STORAGE_PATH = '~/.openclaw/state/health-sync/health.sqlite';
const DEFAULT_CACHE_TTL = 60;

function resolveStoragePath(api: PluginApi): string {
  const fromConfig = api.config?.storagePath as string | undefined;
  if (fromConfig) return fromConfig;
  return process.env['HEALTH_SYNC_DB_PATH'] ?? DEFAULT_STORAGE_PATH;
}

function resolveApiKey(api: PluginApi, db: DatabaseSync): string {
  // 1. Check plugin config
  const fromConfig = api.config?.apiKey as string | undefined;
  if (fromConfig) return fromConfig;

  // 2. Check environment variable
  const fromEnv = process.env['HEALTH_SYNC_API_KEY'];
  if (fromEnv) return fromEnv;

  // 3. Check previously auto-generated key in DB
  const fromDb = getSyncMetadata(db, 'api_key');
  if (fromDb) return fromDb;

  // 4. Auto-generate and persist
  const generated = randomUUID();
  setSyncMetadata(db, 'api_key', generated);
  console.log('[health-sync] No API key configured. Generated one automatically:');
  console.log(`[health-sync]   ${generated}`);
  console.log('[health-sync]   Copy this into your iOS app\'s plugin settings.');
  return generated;
}

function resolveCacheTtl(api: PluginApi): number {
  const fromConfig = api.config?.summaryCacheTtlMinutes as number | undefined;
  if (fromConfig !== undefined) return fromConfig;
  const fromEnv = process.env['HEALTH_SYNC_CACHE_TTL'];
  if (fromEnv) return parseInt(fromEnv, 10);
  return DEFAULT_CACHE_TTL;
}

function resolveTimezone(api: PluginApi): string {
  const fromConfig = api.config?.timezone as string | undefined;
  if (fromConfig) return fromConfig;
  const fromEnv = process.env['HEALTH_SYNC_TIMEZONE'];
  if (fromEnv) return fromEnv;
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function getStoragePath(api: PluginApi): string {
  return resolveStoragePath(api);
}

export function getConfig(api: PluginApi, db: DatabaseSync): PluginConfig {
  return {
    apiKey: resolveApiKey(api, db),
    storagePath: resolveStoragePath(api),
    summaryCacheTtlMinutes: resolveCacheTtl(api),
    timezone: resolveTimezone(api),
  };
}
