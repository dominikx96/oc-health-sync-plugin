import 'https://deno.land/std@0.224.0/dotenv/load.ts';

Deno.serve((_req) => {
  return new Response(JSON.stringify({ error: { code: 'not_implemented', message: 'wire up later' } }), {
    status: 501,
    headers: { 'content-type': 'application/json' }
  });
});
