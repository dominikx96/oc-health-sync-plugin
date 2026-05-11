import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPool } from '../../db.js';
import { submitSessionBulk } from './bulk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const writePool = createPool(process.env.MCP_GYM_WRITER_URL  ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
});

const fixture = JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/bulk-session.json'), 'utf8'));

describe('submitSessionBulk', () => {
  it('rejects unknown gym slug', async () => {
    await expect(submitSessionBulk(writePool, fixture)).rejects.toThrow(/unknown gym slug.*fitfabric-wola/i);
  });

  it('rejects unknown exercise slug when gym exists', async () => {
    await adminPool.query(`INSERT INTO gyms (slug, display_name) VALUES ('fitfabric-wola', 'FitFabric Wola')`);
    await expect(submitSessionBulk(writePool, fixture)).rejects.toThrow(/unknown exercise slug.*seated-cable-row/i);
  });

  it('imports a complete session atomically and is idempotent on session_uuid', async () => {
    await adminPool.query(`INSERT INTO gyms (slug, display_name) VALUES ('fitfabric-wola', 'FitFabric Wola')`);
    await adminPool.query(`INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES ('seated-cable-row', 'Seated Cable Row', 'lats', 'cable')`);

    const first = await submitSessionBulk(writePool, fixture);
    expect(first.summary.total_sets).toBe(3);
    expect(first.summary.total_volume_kg).toBe(12*50 + 10*55 + 8*60);

    const second = await submitSessionBulk(writePool, fixture);
    expect(second.session_id).toBe(first.session_id); // idempotent
  });

  it('a malformed payload (missing required field) is rejected by Zod', async () => {
    const broken = { ...fixture, gym_slug: undefined };
    await expect(submitSessionBulk(writePool, broken)).rejects.toThrow(/gym_slug/i);
  });
});
