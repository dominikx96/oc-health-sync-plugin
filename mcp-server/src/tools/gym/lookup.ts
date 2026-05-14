import type { Pool } from '../../db.js';

export interface LastSessionRow {
  session_id: number;
  gym_id: number;
  gym_slug: string;
  same_gym: boolean;
  started_at: Date;
  ended_at: Date;
  rating: number | null;
  total_sets: number;
  total_volume_kg: number;
  top_set: { exercise: string; reps: number; weight_kg: number } | null;
}

export async function lastSessionSummary(pool: Pool, input: { type: string; gym_id: number }): Promise<{ rows: LastSessionRow[] }> {
  const r = await pool.query<Record<string, unknown>>(
    `SELECT session_id, gym_id, gym_slug, same_gym, started_at, ended_at, rating,
            total_sets, total_volume_kg, top_set
       FROM last_sessions_by_type($1, $2)`,
    [input.type, input.gym_id]
  );
  return {
    rows: r.rows.map((row) => ({
      ...(row as Omit<LastSessionRow, 'total_sets' | 'total_volume_kg'>),
      total_sets: Number(row.total_sets),
      total_volume_kg: Number(row.total_volume_kg)
    })) as LastSessionRow[]
  };
}

export interface LastExerciseRow {
  training_exercise_id: number;
  session_id: number;
  gym_id: number;
  gym_slug: string;
  same_gym: boolean;
  performed_at: Date;
  sets: Array<{ set_index: number; reps: number | null; weight_kg: number | null; rpe: number | null; is_warmup: boolean; without_break: boolean; notes: string | null }>;
}

export async function lastExerciseResults(
  pool: Pool,
  input: { exercise_id?: number; exercise_slug?: string; current_gym_id: number }
): Promise<{ rows: LastExerciseRow[] }> {
  let exerciseId = input.exercise_id;
  if (!exerciseId) {
    if (!input.exercise_slug) throw new Error('exercise_id or exercise_slug required');
    const r = await pool.query<{ id: number }>(`SELECT id FROM exercises WHERE slug = $1 AND deleted_at IS NULL`, [input.exercise_slug]);
    if (!r.rows[0]) throw new Error(`unknown exercise slug: ${input.exercise_slug}`);
    exerciseId = r.rows[0].id;
  }
  const r = await pool.query<LastExerciseRow>(
    `SELECT training_exercise_id, session_id, gym_id, gym_slug, same_gym, performed_at, sets
       FROM last_exercise_results($1, $2)`,
    [exerciseId, input.current_gym_id]
  );
  return { rows: r.rows };
}
