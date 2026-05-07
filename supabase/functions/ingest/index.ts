import { checkBearer } from './auth.ts';
import { IngestPayloadSchema } from './schema.ts';
import { makeSql } from './db.ts';
import { handleIngest } from './handler.ts';

const sql = makeSql();

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return jsonError(405, 'method_not_allowed', 'POST only');
  if (!checkBearer(req.headers)) return jsonError(401, 'unauthorized', 'invalid bearer');

  let raw: unknown;
  try { raw = await req.json(); } catch {
    return jsonError(400, 'invalid_json', 'body is not valid JSON');
  }

  const parsed = IngestPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return jsonError(400, 'invalid_payload', parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  try {
    const result = await handleIngest(sql, parsed.data);
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  } catch (e) {
    console.error('ingest failed:', e);
    return jsonError(500, 'server_error', 'unexpected error');
  }
});
