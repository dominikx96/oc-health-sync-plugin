import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './http.js';

export function extractBearerToken(req: IncomingMessage): string | null {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) return null;
  return auth.slice(7);
}

export function validateApiKey(
  req: IncomingMessage,
  expectedKey: string,
): boolean {
  const token = extractBearerToken(req);
  if (!token) return false;

  const a = Buffer.from(token);
  const b = Buffer.from(expectedKey);
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

export function sendUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, { error: 'unauthorized', message: 'Invalid API key' });
}
