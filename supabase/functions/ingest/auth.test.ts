import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { checkBearer } from './auth.ts';

Deno.test('checkBearer accepts the configured token', () => {
  Deno.env.set('INGEST_API_KEY', 'secret-token-123');
  const headers = new Headers({ authorization: 'Bearer secret-token-123' });
  assert(checkBearer(headers));
});

Deno.test('checkBearer rejects a bad token', () => {
  Deno.env.set('INGEST_API_KEY', 'secret-token-123');
  const headers = new Headers({ authorization: 'Bearer wrong' });
  assertEquals(checkBearer(headers), false);
});

Deno.test('checkBearer rejects when header missing', () => {
  Deno.env.set('INGEST_API_KEY', 'secret-token-123');
  const headers = new Headers({});
  assertEquals(checkBearer(headers), false);
});

Deno.test('checkBearer rejects when env missing', () => {
  Deno.env.delete('INGEST_API_KEY');
  const headers = new Headers({ authorization: 'Bearer anything' });
  assertEquals(checkBearer(headers), false);
});
