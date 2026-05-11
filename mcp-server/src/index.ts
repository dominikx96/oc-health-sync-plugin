import { randomUUID } from 'node:crypto';
import express from 'express';
import { McpServer, isInitializeRequest } from '@modelcontextprotocol/server';
import { createMcpExpressApp } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';

import { bearerAuth } from './auth.js';
import { createPool, type Pool } from './db.js';
import { healthSummary } from './tools/health-summary.js';
import { healthAnomalies } from './tools/health-anomalies.js';
import { runSql } from './tools/run-sql.js';
import { describeSchema } from './resources/schema.js';

function buildMcp(readPool: Pool, writePool: Pool): McpServer {
  void writePool; // unused until gym tool registrations are appended in later tasks
  const server = new McpServer({ name: 'oc-health-sync', version: '0.1.0' });

  server.registerTool(
    'health_summary',
    {
      description: 'Daily, weekly, or monthly health summary as markdown.',
      inputSchema: z.object({
        period: z.enum(['day', 'week', 'month']),
        date:   z.string().optional(),
        tz:     z.string().optional()
      })
    },
    async (input) => ({ content: [{ type: 'text', text: await healthSummary(readPool, input) }] })
  );

  server.registerTool(
    'health_anomalies',
    {
      description: 'Detected anomalies in the trailing window (default 14 days).',
      inputSchema: z.object({ window_days: z.number().int().positive().optional() })
    },
    async (input) => ({ content: [{ type: 'text', text: await healthAnomalies(readPool, input) }] })
  );

  server.registerTool(
    'run_sql',
    {
      description: 'Run a single read-only SQL statement against the health database. 5s statement timeout. Use `schema://tables` to discover the schema.',
      inputSchema: z.object({ query: z.string().min(1) })
    },
    async (input) => {
      const result = await runSql(readPool, input);
      return { content: [{ type: 'text', text: JSON.stringify(result.rows, null, 2) }] };
    }
  );

  server.registerResource(
    'schema',
    'schema://tables',
    { description: 'Database schema summary and example queries.', mimeType: 'text/markdown' },
    async () => ({
      contents: [{ uri: 'schema://tables', mimeType: 'text/markdown', text: await describeSchema(readPool) }]
    })
  );

  // Gym tool registrations will be appended in later tasks.

  return server;
}

export interface ServerHandle {
  port:  number;
  close: () => Promise<void>;
}

export async function startServer(requestedPort: number): Promise<ServerHandle> {
  const readDsn  = process.env.MCP_DATABASE_URL;
  const writeDsn = process.env.MCP_GYM_WRITER_URL;
  if (!readDsn)  throw new Error('MCP_DATABASE_URL is not set');
  if (!writeDsn) throw new Error('MCP_GYM_WRITER_URL is not set');
  const readPool  = createPool(readDsn);
  const writePool = createPool(writeDsn);

  // createMcpExpressApp defaults to 127.0.0.1 with DNS rebinding protection;
  // pass host '0.0.0.0' so tests can bind to any port without DNS validation errors.
  const app = createMcpExpressApp({ host: '0.0.0.0' });
  app.use(express.json());
  app.use(bearerAuth);

  const transports = new Map<string, NodeStreamableHTTPServerTransport>();

  app.post('/mcp', async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => { transports.set(sid, transport!); }
      });
      transport.onclose = () => {
        if (transport!.sessionId) transports.delete(transport!.sessionId);
      };
      // Each session gets its own McpServer so tools/resources are independent.
      const mcp = buildMcp(readPool, writePool);
      await mcp.connect(transport);
    }

    if (!transport) {
      res.status(400).json({ error: 'no session' });
      return;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const s = app.listen(requestedPort, () => resolve(s));
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const t of transports.values()) await t.close();
      await readPool.end();
      await writePool.end();
    }
  };
}

// CLI entry: trigger for both built (`node dist/index.js`) and dev (`tsx src/index.ts`)
// invocations. Tests import startServer directly and have a different argv[1].
const entryArg = process.argv[1] ?? '';
if (entryArg.endsWith('index.js') || entryArg.endsWith('index.ts')) {
  const port = Number(process.env.MCP_PORT ?? 3737);
  startServer(port).then((h) => {
    console.log(`mcp-server listening on http://127.0.0.1:${h.port}/mcp`);
  }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
