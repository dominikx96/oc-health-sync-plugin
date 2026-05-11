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
import { searchExercises, createExercise, searchGyms, createGym, searchMachines, createMachine } from './tools/gym/catalog.js';
import { startSession, currentSession, finishSession } from './tools/gym/session.js';
import { logSet, addNote } from './tools/gym/sets.js';
import { lastSessionSummary, lastExerciseResults } from './tools/gym/lookup.js';
import { submitSessionBulk } from './tools/gym/bulk.js';

function buildMcp(readPool: Pool, writePool: Pool): McpServer {
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

  const text = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

  // --- Catalog (search uses readPool, create uses writePool) -------------
  server.registerTool('gym_search_exercises',
    { description: 'Search exercises by name/slug substring. Use before gym_create_exercise to avoid duplicates.',
      inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().positive().optional() }) },
    async (i) => text(await searchExercises(readPool, i))
  );
  server.registerTool('gym_create_exercise',
    { description: 'Create a new exercise. Search first; only call after the user confirms.',
      inputSchema: z.object({
        slug: z.string().min(1),
        display_name: z.string().min(1),
        primary_muscle: z.string().min(1),
        secondary_muscles: z.array(z.string()).optional(),
        mechanic: z.enum(['compound','isolation']).nullable().optional(),
        equipment_class: z.string().min(1)
      }) },
    async (i) => text(await createExercise(writePool, i))
  );
  server.registerTool('gym_search_gyms',
    { description: 'Search gyms by name/slug/city substring.',
      inputSchema: z.object({ query: z.string().optional(), limit: z.number().int().positive().optional() }) },
    async (i) => text(await searchGyms(readPool, i))
  );
  server.registerTool('gym_create_gym',
    { description: 'Create a new gym after user confirmation.',
      inputSchema: z.object({ slug: z.string().min(1), display_name: z.string().min(1), city: z.string().optional(), notes: z.string().optional() }) },
    async (i) => text(await createGym(writePool, i))
  );
  server.registerTool('gym_search_machines',
    { description: 'List machines at a gym (optionally filtered by exercise).',
      inputSchema: z.object({ gym_id: z.number().int().positive(), exercise_id: z.number().int().positive().optional(), query: z.string().optional(), limit: z.number().int().positive().optional() }) },
    async (i) => text(await searchMachines(readPool, i))
  );
  server.registerTool('gym_create_machine',
    { description: 'Create a machine at a gym for an exercise.',
      inputSchema: z.object({ gym_id: z.number().int().positive(), exercise_id: z.number().int().positive(), manufacturer: z.string().optional(), model: z.string().optional(), label: z.string().optional(), notes: z.string().optional() }) },
    async (i) => text(await createMachine(writePool, i))
  );

  // --- Session ---------------------------------------------------------
  server.registerTool('gym_start_session',
    { description: 'Start a new live session. Fails if another is open; pass force=true to auto-finalize the stale one.',
      inputSchema: z.object({
        session_uuid: z.string().min(1),
        gym_id: z.number().int().positive(),
        type: z.enum(['push','pull','legs','upper','lower','full','cardio','mobility','other']),
        started_at: z.string().optional(),
        force: z.boolean().optional()
      }) },
    async (i) => text(await startSession(writePool, i))
  );
  server.registerTool('gym_current_session',
    { description: 'Return the open session (or null).', inputSchema: z.object({}) },
    async () => text(await currentSession(readPool))
  );
  server.registerTool('gym_finish_session',
    { description: 'Finalize a session with optional rating (1..10) and notes. Returns a summary.',
      inputSchema: z.object({
        session_id: z.number().int().positive(),
        rating: z.number().int().min(1).max(10).optional(),
        notes: z.string().optional(),
        ended_at: z.string().optional()
      }) },
    async (i) => text(await finishSession(writePool, i))
  );

  // --- Sets -----------------------------------------------------------
  server.registerTool('gym_log_set',
    { description: 'Log a single set. Pass training_exercise_id to reuse a block, or exercise_id (+gym_machine_id?) to start a new one. Caller must reuse the returned training_exercise_id for subsequent sets of the same exercise.',
      inputSchema: z.object({
        session_id: z.number().int().positive(),
        training_exercise_id: z.number().int().positive().optional(),
        exercise_id: z.number().int().positive().optional(),
        gym_machine_id: z.number().int().positive().optional(),
        set_uuid: z.string().min(1),
        reps: z.number().int().optional(),
        weight_kg: z.number().optional(),
        duration_seconds: z.number().optional(),
        distance_m: z.number().optional(),
        rpe: z.number().int().min(1).max(10).optional(),
        is_warmup: z.boolean().optional(),
        notes: z.string().optional(),
        performed_at: z.string().optional(),
        set_index: z.number().int().positive().optional()
      }) },
    async (i) => text(await logSet(writePool, i))
  );
  server.registerTool('gym_add_note',
    { description: 'Append a free-text note to a session, exercise, or set. Newline-appended; never destructive.',
      inputSchema: z.object({
        session_id: z.number().int().positive(),
        scope: z.enum(['set','exercise','session']),
        target_id: z.number().int().positive().optional(),
        text: z.string().min(1)
      }) },
    async (i) => { await addNote(writePool, i); return text({ ok: true }); }
  );

  // --- Lookup ----------------------------------------------------------
  server.registerTool('gym_last_session_summary',
    { description: 'Up to 2 rows: most-recent same-gym session of this type, then most-recent other-gym session.',
      inputSchema: z.object({
        type: z.enum(['push','pull','legs','upper','lower','full','cardio','mobility','other']),
        gym_id: z.number().int().positive()
      }) },
    async (i) => text(await lastSessionSummary(readPool, i))
  );
  server.registerTool('gym_last_exercise_results',
    { description: 'Up to 2 rows of prior performances of this exercise: same-gym then other-gym.',
      inputSchema: z.object({
        exercise_id: z.number().int().positive().optional(),
        exercise_slug: z.string().optional(),
        current_gym_id: z.number().int().positive()
      }) },
    async (i) => text(await lastExerciseResults(readPool, i))
  );

  // --- Bulk ------------------------------------------------------------
  server.registerTool('gym_submit_session_bulk',
    { description: 'Atomic import of a complete finished session. Rejects unknown slugs. Idempotent on session_uuid.',
      inputSchema: z.object({
        session_uuid: z.string().min(1),
        gym_slug:     z.string().min(1),
        type:         z.enum(['push','pull','legs','upper','lower','full','cardio','mobility','other']),
        started_at:   z.string(),
        ended_at:     z.string(),
        rating:       z.number().int().min(1).max(10).nullable().optional(),
        notes:        z.string().nullable().optional(),
        exercises:    z.array(z.object({
          exercise_slug: z.string().min(1),
          exercise_uuid: z.string().min(1),
          machine:       z.object({ manufacturer: z.string().nullable().optional(), model: z.string().nullable().optional(), label: z.string().nullable().optional() }).optional(),
          notes:         z.string().nullable().optional(),
          sets:          z.array(z.object({
            set_uuid:         z.string().min(1),
            set_index:        z.number().int().positive().optional(),
            reps:             z.number().int().optional(),
            weight_kg:        z.number().optional(),
            duration_seconds: z.number().optional(),
            distance_m:       z.number().optional(),
            rpe:              z.number().int().min(1).max(10).optional(),
            is_warmup:        z.boolean().optional(),
            notes:            z.string().nullable().optional(),
            performed_at:     z.string().optional()
          })).min(1)
        })).min(1)
      }) },
    async (i) => text(await submitSessionBulk(writePool, i))
  );

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
