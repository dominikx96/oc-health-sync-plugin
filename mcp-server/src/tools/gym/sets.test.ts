import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPool } from '../../db.js';
import { logSet, addNote } from './sets.js';
import { createGym, createExercise } from './catalog.js';
import { startSession } from './session.js';

const writePool = createPool(process.env.MCP_GYM_WRITER_URL  ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');
afterAll(async () => { await writePool.end(); await adminPool.end(); });
beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
});

async function freshSession() {
  const gym = await createGym(writePool, { slug: 'g', display_name: 'G' });
  const ex  = await createExercise(writePool, { slug: 'row', display_name: 'Row', primary_muscle: 'lats', equipment_class: 'cable' });
  const s   = await startSession(writePool, { session_uuid: randomUUID(), gym_id: gym.row.id, type: 'pull' });
  return { gym, ex, session_id: s.session_id };
}

describe('logSet', () => {
  it('creates a new training_exercises block on the first set and returns its id', async () => {
    const { ex, session_id } = await freshSession();
    const r = await logSet(writePool, {
      session_id, exercise_id: ex.row.id, set_uuid: randomUUID(), reps: 10, weight_kg: 50
    });
    expect(r.training_exercise_id).toBeGreaterThan(0);
    expect(r.set_index).toBe(1);
  });

  it('reuses the training_exercises block when training_exercise_id is passed', async () => {
    const { ex, session_id } = await freshSession();
    const first = await logSet(writePool, {
      session_id, exercise_id: ex.row.id, set_uuid: randomUUID(), reps: 10, weight_kg: 50
    });
    const second = await logSet(writePool, {
      session_id, training_exercise_id: first.training_exercise_id, set_uuid: randomUUID(), reps: 8, weight_kg: 55
    });
    expect(second.training_exercise_id).toBe(first.training_exercise_id);
    expect(second.set_index).toBe(2);
  });

  it('is idempotent on set_uuid (no duplicate row, returns the existing set)', async () => {
    const { ex, session_id } = await freshSession();
    const u = randomUUID();
    const a = await logSet(writePool, { session_id, exercise_id: ex.row.id, set_uuid: u, reps: 10, weight_kg: 50 });
    const b = await logSet(writePool, { session_id, exercise_id: ex.row.id, set_uuid: u, reps: 999, weight_kg: 999 });
    expect(b.set_id).toBe(a.set_id);
    const stored = await adminPool.query(`SELECT reps, weight_kg FROM training_sets WHERE id = $1`, [a.set_id]);
    expect(stored.rows[0]).toEqual({ reps: 10, weight_kg: 50 });
  });

  it('rejects a set with no measurement', async () => {
    const { ex, session_id } = await freshSession();
    await expect(logSet(writePool, {
      session_id, exercise_id: ex.row.id, set_uuid: randomUUID()
    })).rejects.toThrow(/measurement/i);
  });

  it('persists without_break=true and defaults to false when omitted', async () => {
    const { ex, session_id } = await freshSession();
    const a = await logSet(writePool, {
      session_id, exercise_id: ex.row.id, set_uuid: randomUUID(), reps: 10, weight_kg: 50
    });
    const b = await logSet(writePool, {
      session_id, training_exercise_id: a.training_exercise_id, set_uuid: randomUUID(),
      reps: 8, weight_kg: 55, without_break: true
    });
    const r = await adminPool.query<{ id: number; without_break: boolean }>(
      `SELECT id, without_break FROM training_sets WHERE id IN ($1, $2) ORDER BY id`,
      [a.set_id, b.set_id]
    );
    expect(r.rows[0].without_break).toBe(false);
    expect(r.rows[1].without_break).toBe(true);
  });
});

describe('addNote', () => {
  it('appends to session notes', async () => {
    const { session_id } = await freshSession();
    await addNote(writePool, { session_id, scope: 'session', text: 'first note' });
    await addNote(writePool, { session_id, scope: 'session', text: 'second note' });
    const r = await adminPool.query<{ notes: string }>(`SELECT notes FROM training_sessions WHERE id = $1`, [session_id]);
    expect(r.rows[0].notes).toBe('first note\nsecond note');
  });

  it('appends to a set when scope=set and target_id given', async () => {
    const { ex, session_id } = await freshSession();
    const s = await logSet(writePool, { session_id, exercise_id: ex.row.id, set_uuid: randomUUID(), reps: 10, weight_kg: 50 });
    await addNote(writePool, { session_id, scope: 'set', target_id: s.set_id, text: 'shoulder twinge' });
    const r = await adminPool.query<{ notes: string }>(`SELECT notes FROM training_sets WHERE id = $1`, [s.set_id]);
    expect(r.rows[0].notes).toBe('shoulder twinge');
  });

  it('throws when target_id refers to a row that does not exist or is in another session', async () => {
    const { session_id } = await freshSession();
    // wrong target_id for exercise scope
    await expect(addNote(writePool, {
      session_id, scope: 'exercise', target_id: 999_999, text: 'oops'
    })).rejects.toThrow(/note target not found/i);
  });
});
