import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

const URL = 'http://127.0.0.1:54421/functions/v1/ingest';
const KEY = 'test-ingest-key';

Deno.test({
  name: 'POST /ingest returns 401 without auth',
  ignore: !Deno.env.get('RUN_INTEGRATION'),
  async fn() {
    const r = await fetch(URL, { method: 'POST', body: '{}' });
    assertEquals(r.status, 401);
    await r.body?.cancel();
  }
});

Deno.test({
  name: 'POST /ingest returns 400 on bad body',
  ignore: !Deno.env.get('RUN_INTEGRATION'),
  async fn() {
    const r = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: '{}'
    });
    assertEquals(r.status, 400);
    await r.body?.cancel();
  }
});

Deno.test({
  name: 'POST /ingest stores a sample and returns counts',
  ignore: !Deno.env.get('RUN_INTEGRATION'),
  async fn() {
    const body = {
      device_id: 'dev1',
      new_samples: [{
        uuid: 'integration-1',
        sample_kind: 'quantity',
        data_type: 'HKQuantityTypeIdentifierStepCount',
        value: 200,
        unit: 'count',
        start_date: '2026-04-01T10:00:00Z',
        end_date:   '2026-04-01T10:00:00Z',
        source_name: 'iPhone'
      }],
      deleted_ids: []
    };
    const r = await fetch(URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    assertEquals(r.status, 200);
    const json = await r.json();
    assertEquals(json, { received: 1, deleted: 0 });
  }
});
