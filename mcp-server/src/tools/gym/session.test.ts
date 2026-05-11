import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../db.js';
import { startSession, currentSession, finishSession } from './session.js';
import { createGym } from './catalog.js';

const readPool  = createPool(process.env.MCP_DATABASE_URL    ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
const writePool = createPool(process.env.MCP_GYM_WRITER_URL  ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await readPool.end(); await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
});

describe('startSession + currentSession', () => {
  it('creates an open session and exposes it via currentSession', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    const session_uuid = randomUUID();
    const r = await startSession(writePool, { session_uuid, gym_id: gym.row.id, type: 'pull' });
    expect(r.session_id).toBeGreaterThan(0);

    const cur = await currentSession(readPool);
    expect(cur.row?.id).toBe(r.session_id);
    expect(cur.row?.ended_at).toBeNull();
  });

  it('rejects a second start while one is open', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'pull' });
    await expect(startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'push' }))
      .rejects.toThrow(/open session/i);
  });

  it('force=true auto-finalizes the stale open session', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    const first = await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'pull' });
    const second = await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'push', force: true });
    expect(second.session_id).not.toBe(first.session_id);

    // First should now be finalized with the auto-closed note.
    const r = await adminPool.query<{ ended_at: Date | null; notes: string | null }>(
      `SELECT ended_at, notes FROM training_sessions WHERE id = $1`, [first.session_id]
    );
    expect(r.rows[0].ended_at).not.toBeNull();
    expect(r.rows[0].notes).toMatch(/auto-closed/);
  });

  it('is idempotent on session_uuid', async () => {
    const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
    const u = randomUUID();
    const r1 = await startSession(writePool, { session_uuid: u, gym_id: gym.row.id, type: 'pull' });
    const r2 = await startSession(writePool, { session_uuid: u, gym_id: gym.row.id, type: 'pull' });
    expect(r2.session_id).toBe(r1.session_id);
  });
});
