import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { bearerAuth } from './auth.js';

describe('bearerAuth middleware', () => {
  beforeEach(() => { process.env.MCP_API_KEY = 'mcp-secret'; });

  function buildApp() {
    const app = express();
    app.use(bearerAuth);
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    return app;
  }

  async function fetchOnce(app: express.Express, headers: Record<string, string>) {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/ping`, { headers });
      return { status: r.status };
    } finally {
      server.close();
    }
  }

  it('200 with correct token', async () => {
    const r = await fetchOnce(buildApp(), { authorization: 'Bearer mcp-secret' });
    expect(r.status).toBe(200);
  });

  it('401 with wrong token', async () => {
    const r = await fetchOnce(buildApp(), { authorization: 'Bearer wrong' });
    expect(r.status).toBe(401);
  });

  it('401 with missing header', async () => {
    const r = await fetchOnce(buildApp(), {});
    expect(r.status).toBe(401);
  });
});
