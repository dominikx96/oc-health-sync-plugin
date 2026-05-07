import { timingSafeEqual } from 'https://deno.land/std@0.224.0/crypto/timing_safe_equal.ts';

export function checkBearer(headers: Headers): boolean {
  const expected = Deno.env.get('INGEST_API_KEY');
  if (!expected) return false;

  const authz = headers.get('authorization');
  if (!authz || !authz.startsWith('Bearer ')) return false;

  const provided = authz.slice('Bearer '.length);

  // Pad to constant length to avoid leaking length.
  const a = new TextEncoder().encode(provided);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return timingSafeEqual(a, b);
}
