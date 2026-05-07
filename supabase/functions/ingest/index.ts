// Placeholder — full handler is wired up in Task 2.5.
// Edge Function env comes from the Supabase runtime, no dotenv needed.
Deno.serve((_req) => {
  return new Response(JSON.stringify({ error: { code: 'not_implemented', message: 'wire up later' } }), {
    status: 501,
    headers: { 'content-type': 'application/json' }
  });
});
