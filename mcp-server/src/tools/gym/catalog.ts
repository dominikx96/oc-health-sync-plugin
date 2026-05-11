import type { Pool } from '../../db.js';

export interface ExerciseRow {
  id: number;
  slug: string;
  display_name: string;
  primary_muscle: string;
  secondary_muscles: string[];
  mechanic: string | null;
  equipment_class: string;
}

export interface SearchExercisesInput { query?: string; limit?: number }
export interface SearchExercisesResult { rows: ExerciseRow[] }

const DEFAULT_LIMIT = 20;

export async function searchExercises(pool: Pool, input: SearchExercisesInput): Promise<SearchExercisesResult> {
  const q = (input.query ?? '').trim();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const r = await pool.query<ExerciseRow>(
    `SELECT id, slug, display_name, primary_muscle, secondary_muscles, mechanic, equipment_class
       FROM exercises
      WHERE deleted_at IS NULL
        AND ($1 = '' OR display_name ILIKE '%' || $1 || '%' OR slug ILIKE '%' || $1 || '%')
      ORDER BY display_name
      LIMIT $2`,
    [q, limit]
  );
  return { rows: r.rows };
}

export interface CreateExerciseInput {
  slug: string;
  display_name: string;
  primary_muscle: string;
  secondary_muscles?: string[];
  mechanic?: 'compound' | 'isolation' | null;
  equipment_class: string;
}
export interface CreateExerciseResult { row: ExerciseRow; created: boolean }

export async function createExercise(pool: Pool, input: CreateExerciseInput): Promise<CreateExerciseResult> {
  const r = await pool.query<ExerciseRow>(
    `INSERT INTO exercises (slug, display_name, primary_muscle, secondary_muscles, mechanic, equipment_class)
     VALUES ($1, $2, $3, COALESCE($4::text[], '{}'), $5, $6)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, display_name, primary_muscle, secondary_muscles, mechanic, equipment_class`,
    [input.slug, input.display_name, input.primary_muscle, input.secondary_muscles ?? null, input.mechanic ?? null, input.equipment_class]
  );
  if (r.rows[0]) return { row: r.rows[0], created: true };
  const existing = await pool.query<ExerciseRow>(
    `SELECT id, slug, display_name, primary_muscle, secondary_muscles, mechanic, equipment_class
       FROM exercises WHERE slug = $1`,
    [input.slug]
  );
  return { row: existing.rows[0], created: false };
}

export interface GymRow { id: number; slug: string; display_name: string; city: string | null; notes: string | null }
export interface MachineRow { id: number; gym_id: number; exercise_id: number; manufacturer: string | null; model: string | null; label: string | null; notes: string | null }

export interface SearchGymsInput { query?: string; limit?: number }
export async function searchGyms(pool: Pool, input: SearchGymsInput): Promise<{ rows: GymRow[] }> {
  const q = (input.query ?? '').trim();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const r = await pool.query<GymRow>(
    `SELECT id, slug, display_name, city, notes
       FROM gyms
      WHERE deleted_at IS NULL
        AND ($1 = '' OR display_name ILIKE '%' || $1 || '%' OR slug ILIKE '%' || $1 || '%' OR COALESCE(city,'') ILIKE '%' || $1 || '%')
      ORDER BY display_name
      LIMIT $2`,
    [q, limit]
  );
  return { rows: r.rows };
}

export interface CreateGymInput { slug: string; display_name: string; city?: string; notes?: string }
export async function createGym(pool: Pool, input: CreateGymInput): Promise<{ row: GymRow; created: boolean }> {
  const r = await pool.query<GymRow>(
    `INSERT INTO gyms (slug, display_name, city, notes) VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO NOTHING
     RETURNING id, slug, display_name, city, notes`,
    [input.slug, input.display_name, input.city ?? null, input.notes ?? null]
  );
  if (r.rows[0]) return { row: r.rows[0], created: true };
  const existing = await pool.query<GymRow>(`SELECT id, slug, display_name, city, notes FROM gyms WHERE slug = $1`, [input.slug]);
  return { row: existing.rows[0], created: false };
}

export interface SearchMachinesInput { gym_id: number; exercise_id?: number; query?: string; limit?: number }
export async function searchMachines(pool: Pool, input: SearchMachinesInput): Promise<{ rows: MachineRow[] }> {
  const q = (input.query ?? '').trim();
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), 100);
  const r = await pool.query<MachineRow>(
    `SELECT id, gym_id, exercise_id, manufacturer, model, label, notes
       FROM gym_machines
      WHERE deleted_at IS NULL
        AND gym_id = $1
        AND ($2::bigint IS NULL OR exercise_id = $2)
        AND ($3 = '' OR COALESCE(manufacturer,'') ILIKE '%' || $3 || '%' OR COALESCE(model,'') ILIKE '%' || $3 || '%' OR COALESCE(label,'') ILIKE '%' || $3 || '%')
      ORDER BY id
      LIMIT $4`,
    [input.gym_id, input.exercise_id ?? null, q, limit]
  );
  return { rows: r.rows };
}

export interface CreateMachineInput { gym_id: number; exercise_id: number; manufacturer?: string; model?: string; label?: string; notes?: string }
export async function createMachine(pool: Pool, input: CreateMachineInput): Promise<{ row: MachineRow; created: boolean }> {
  // The unique index uses COALESCE(... , '') — search the same way for the existing row.
  const existing = await pool.query<MachineRow>(
    `SELECT id, gym_id, exercise_id, manufacturer, model, label, notes
       FROM gym_machines
      WHERE deleted_at IS NULL
        AND gym_id = $1
        AND exercise_id = $2
        AND COALESCE(manufacturer, '') = COALESCE($3::text, '')
        AND COALESCE(model, '')        = COALESCE($4::text, '')`,
    [input.gym_id, input.exercise_id, input.manufacturer ?? null, input.model ?? null]
  );
  if (existing.rows[0]) return { row: existing.rows[0], created: false };

  const r = await pool.query<MachineRow>(
    `INSERT INTO gym_machines (gym_id, exercise_id, manufacturer, model, label, notes)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, gym_id, exercise_id, manufacturer, model, label, notes`,
    [input.gym_id, input.exercise_id, input.manufacturer ?? null, input.model ?? null, input.label ?? null, input.notes ?? null]
  );
  return { row: r.rows[0], created: true };
}
