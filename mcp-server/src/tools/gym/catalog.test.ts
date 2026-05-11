import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { searchExercises } from './catalog.js';

const readPool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await readPool.end(); await adminPool.end(); });

beforeEach(async () => {
  await adminPool.query('TRUNCATE training_sets, training_exercises, training_sessions, gym_machines, exercises, gyms RESTART IDENTITY CASCADE');
});

describe('searchExercises', () => {
  it('returns exercises matching by display_name fragment (case-insensitive)', async () => {
    await adminPool.query(`
      INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES
        ('seated-cable-row', 'Seated Cable Row', 'lats',  'cable'),
        ('bench-press',      'Bench Press',      'chest', 'barbell')
    `);
    const r = await searchExercises(readPool, { query: 'cable' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].slug).toBe('seated-cable-row');
  });

  it('returns all when query is empty', async () => {
    await adminPool.query(`
      INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class) VALUES
        ('a', 'A', 'm', 'machine'), ('b', 'B', 'm', 'machine')
    `);
    const r = await searchExercises(readPool, {});
    expect(r.rows).toHaveLength(2);
  });

  it('excludes soft-deleted rows', async () => {
    await adminPool.query(`
      INSERT INTO exercises (slug, display_name, primary_muscle, equipment_class, deleted_at)
        VALUES ('gone', 'Gone', 'm', 'machine', now())
    `);
    const r = await searchExercises(readPool, {});
    expect(r.rows).toHaveLength(0);
  });
});
