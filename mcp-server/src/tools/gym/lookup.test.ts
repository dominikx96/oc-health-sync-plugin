import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { lastSessionSummary, lastExerciseResults } from './lookup.js';

const readPool  = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');
afterAll(async () => { await readPool.end(); await adminPool.end(); });

beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
  await adminPool.query(`
    INSERT INTO gyms (slug, display_name) VALUES ('wola', 'Wola'), ('mok', 'Mokotów');
    INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES ('row', 'Row', 'lats', 'cable');
  `);
  await adminPool.query(`
    -- older session at Wola
    INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating)
      VALUES ('s-wola', (SELECT id FROM gyms WHERE slug='wola'), 'pull',
              '2026-04-15T17:00:00Z', '2026-04-15T18:00:00Z', 6);
    INSERT INTO training_exercises (uuid, session_id, exercise_id, position)
      VALUES ('te-wola', (SELECT id FROM training_sessions WHERE uuid='s-wola'),
              (SELECT id FROM exercises WHERE slug='row'), 1);
    INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg)
      VALUES ('st-wola-1', (SELECT id FROM training_exercises WHERE uuid='te-wola'), 1, 10, 50),
             ('st-wola-2', (SELECT id FROM training_exercises WHERE uuid='te-wola'), 2, 10, 55);

    -- newer session at Mokotów
    INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating)
      VALUES ('s-mok', (SELECT id FROM gyms WHERE slug='mok'), 'pull',
              '2026-05-08T17:00:00Z', '2026-05-08T18:00:00Z', 8);
    INSERT INTO training_exercises (uuid, session_id, exercise_id, position)
      VALUES ('te-mok', (SELECT id FROM training_sessions WHERE uuid='s-mok'),
              (SELECT id FROM exercises WHERE slug='row'), 1);
    INSERT INTO training_sets (uuid, training_exercise_id, set_index, reps, weight_kg)
      VALUES ('st-mok-1', (SELECT id FROM training_exercises WHERE uuid='te-mok'), 1, 10, 60);
  `);
});

describe('lookup', () => {
  it('lastSessionSummary returns same-gym row first, then other-gym row', async () => {
    const wolaId = (await adminPool.query<{ id: number }>(`SELECT id FROM gyms WHERE slug='wola'`)).rows[0].id;
    const r = await lastSessionSummary(readPool, { type: 'pull', gym_id: wolaId });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].same_gym).toBe(true);
    expect(r.rows[0].total_sets).toBe(2);
    expect(r.rows[1].same_gym).toBe(false);
  });

  it('lastExerciseResults returns sets[] for each row', async () => {
    const wolaId = (await adminPool.query<{ id: number }>(`SELECT id FROM gyms WHERE slug='wola'`)).rows[0].id;
    const exId   = (await adminPool.query<{ id: number }>(`SELECT id FROM exercises WHERE slug='row'`)).rows[0].id;
    const r = await lastExerciseResults(readPool, { exercise_id: exId, current_gym_id: wolaId });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].same_gym).toBe(true);
    expect(Array.isArray(r.rows[0].sets)).toBe(true);
    expect(r.rows[0].sets).toHaveLength(2);
  });

  it('accepts exercise_slug as an alternative to exercise_id', async () => {
    const wolaId = (await adminPool.query<{ id: number }>(`SELECT id FROM gyms WHERE slug='wola'`)).rows[0].id;
    const r = await lastExerciseResults(readPool, { exercise_slug: 'row', current_gym_id: wolaId });
    expect(r.rows).toHaveLength(2);
  });
});
