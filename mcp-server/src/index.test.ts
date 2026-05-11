import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startServer } from './index.js';

describe('mcp server end-to-end', () => {
  let close: () => Promise<void>;
  let port: number;

  beforeAll(async () => {
    process.env.MCP_API_KEY = 'mcp-test-key';
    process.env.MCP_DATABASE_URL   = 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres';
    process.env.MCP_GYM_WRITER_URL = 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres';
    const handle = await startServer(0);
    close = handle.close;
    port = handle.port;
  });

  afterAll(async () => { await close(); });

  it('rejects /mcp without auth', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
    expect(r.status).toBe(401);
  });

  it('accepts an initialize request with auth and lists tools', async () => {
    // 1. initialize
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer mcp-test-key',
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '0' } }
      })
    });
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await init.body?.cancel();

    // 2. tools/list
    const list = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'authorization': 'Bearer mcp-test-key',
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        'mcp-session-id': sessionId!
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    expect(list.status).toBe(200);
    const text = await list.text();
    expect(text).toMatch(/health_summary/);
    expect(text).toMatch(/health_anomalies/);
    expect(text).toMatch(/run_sql/);
  });
});
