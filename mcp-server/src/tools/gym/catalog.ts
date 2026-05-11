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
