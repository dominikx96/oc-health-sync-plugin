# `ingest` Edge Function

Receives Apple HealthKit samples from the iOS app and writes them to Postgres
through `health_ingest_role`. Single-user deployment, bearer-token auth.

## Local development

The Edge Function runs inside the Supabase functions container, so its view of
the host network is *not* `127.0.0.1` — that resolves to the container itself.
Use `host.docker.internal` to reach the local Postgres exposed on port 54422.

1. Create a local `.env` (gitignored) with the runtime config:

   ```ini
   INGEST_API_KEY=test-ingest-key
   INGEST_DATABASE_URL=postgresql://ingest_user:ingest_pw@host.docker.internal:54422/postgres
   ```

2. Bring up the Supabase stack and apply migrations:

   ```bash
   cd supabase
   supabase start
   supabase db reset   # applies migrations + seed.sql (creates ingest_user)
   ```

3. Serve the function:

   ```bash
   supabase functions serve ingest --no-verify-jwt --env-file ./functions/ingest/.env
   ```

   `--no-verify-jwt` disables Supabase Auth's GoTrue check (we don't use
   GoTrue — auth happens via our own bearer-token middleware).

4. Hit it:

   ```bash
   curl -sS -X POST http://127.0.0.1:54421/functions/v1/ingest \
     -H "Authorization: Bearer test-ingest-key" \
     -H "Content-Type: application/json" \
     -d '{"device_id":"dev1","new_samples":[],"deleted_ids":[]}'
   # → {"stored":0,"deleted":0}
   ```

## Tests

| File | Run | Notes |
|---|---|---|
| `auth.test.ts` | `deno test --allow-env` | pure unit, no DB |
| `schema.test.ts` | `deno test --allow-env` | pure unit, no DB |
| `handler.test.ts` | `deno test --allow-env --allow-net --allow-read` | hits local Postgres at `127.0.0.1:54422` as `ingest_user` (test code runs on the host, not in the container, so `127.0.0.1` is correct here) |
| `index.test.ts` | `RUN_INTEGRATION=1 deno test --allow-env --allow-net --allow-read` | requires `supabase functions serve ingest` to be running |

`handler.test.ts` and `index.test.ts` both depend on `supabase db reset` having
been run since the last test (they truncate inside `withSql`).
