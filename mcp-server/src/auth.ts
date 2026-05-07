import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

export function bearerAuth(req: Request, res: Response, next: NextFunction): void {
  const expected = process.env.MCP_API_KEY;
  if (!expected) {
    res.status(500).json({ error: 'MCP_API_KEY not configured' });
    return;
  }
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  const provided = header.slice('Bearer '.length);
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}
