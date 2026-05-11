import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { createPool } from '../../db.js';
import { searchExercises, createExercise, searchGyms, createGym, searchMachines, createMachine } from './catalog.js';

const readPool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
const writePool = createPool(process.env.MCP_GYM_WRITER_URL ?? 'postgresql://gym_writer_user:gym_writer_pw@127.0.0.1:54422/postgres');
const adminPool = createPool(process.env.MCP_ADMIN_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54422/postgres');

afterAll(async () => { await readPool.end(); await writePool.end(); await adminPool.end(); });

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

describe('createExercise', () => {
  it('inserts a new exercise', async () => {
    const r = await createExercise(writePool, {
      slug: 'incline-db-press',
      display_name: 'Incline Dumbbell Press',
      primary_muscle: 'chest',
      secondary_muscles: ['front delts', 'triceps'],
      mechanic: 'compound',
      equipment_class: 'dumbbell'
    });
    expect(r.row.slug).toBe('incline-db-press');
    expect(r.row.secondary_muscles).toEqual(['front delts', 'triceps']);
    expect(r.created).toBe(true);
  });

  it('returns the existing row on slug conflict (idempotent)', async () => {
    await createExercise(writePool, {
      slug: 'lat-pulldown', display_name: 'Lat Pulldown', primary_muscle: 'lats', equipment_class: 'cable'
    });
    const r = await createExercise(writePool, {
      slug: 'lat-pulldown', display_name: 'Lat Pulldown', primary_muscle: 'lats', equipment_class: 'cable'
    });
    expect(r.created).toBe(false);
    expect(r.row.slug).toBe('lat-pulldown');
  });
});

describe('gyms', () => {
  it('createGym + searchGyms', async () => {
    const c = await createGym(writePool, { slug: 'fitfabric-wola', display_name: 'FitFabric Wola', city: 'Warsaw' });
    expect(c.created).toBe(true);
    const s = await searchGyms(readPool, { query: 'fit' });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].slug).toBe('fitfabric-wola');
  });

  it('createGym is idempotent on slug', async () => {
    await createGym(writePool, { slug: 'precor', display_name: 'Precor' });
    const r2 = await createGym(writePool, { slug: 'precor', display_name: 'Precor' });
    expect(r2.created).toBe(false);
  });
});

describe('machines', () => {
  it('createMachine + searchMachines for a (gym, exercise)', async () => {
    const gym = await createGym(writePool, { slug: 'g1', display_name: 'G1' });
    const ex  = await createExercise(writePool, { slug: 'low-row', display_name: 'Low Row', primary_muscle: 'lats', equipment_class: 'machine' });
    const m   = await createMachine(writePool, { gym_id: gym.row.id, exercise_id: ex.row.id, manufacturer: 'Technogym', model: 'Selection 700 Low Row' });
    expect(m.created).toBe(true);
    const s = await searchMachines(readPool, { gym_id: gym.row.id, exercise_id: ex.row.id });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].manufacturer).toBe('Technogym');
  });

  it('createMachine is idempotent on (gym, exercise, manufacturer, model) — including NULLs', async () => {
    const gym = await createGym(writePool, { slug: 'g2', display_name: 'G2' });
    const ex  = await createExercise(writePool, { slug: 'pec-deck', display_name: 'Pec Deck', primary_muscle: 'chest', equipment_class: 'machine' });
    await createMachine(writePool, { gym_id: gym.row.id, exercise_id: ex.row.id });
    const r2 = await createMachine(writePool, { gym_id: gym.row.id, exercise_id: ex.row.id });
    expect(r2.created).toBe(false);
  });
});
