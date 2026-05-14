import type { Pool } from '../../db.js';

export interface LogSetInput {
  session_id: number;
  training_exercise_id?: number;
  exercise_id?: number;
  gym_machine_id?: number;
  set_uuid: string;
  reps?: number;
  weight_kg?: number;
  duration_seconds?: number;
  distance_m?: number;
  rpe?: number;
  is_warmup?: boolean;
  without_break?: boolean;
  notes?: string;
  performed_at?: string;
  set_index?: number;
}

export interface LogSetResult {
  training_exercise_id: number;
  set_id: number;
  set_index: number;
}

export async function logSet(pool: Pool, input: LogSetInput): Promise<LogSetResult> {
  if (input.reps == null && input.duration_seconds == null && input.distance_m == null) {
    throw new Error('at least one measurement (reps, duration_seconds, distance_m) is required');
  }
  if (!input.training_exercise_id && !input.exercise_id) {
    throw new Error('either training_exercise_id or exercise_id is required');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotent: same set_uuid → return existing row, do nothing else.
    const existing = await client.query<{ id: string; training_exercise_id: string; set_index: number }>(
      `SELECT id, training_exercise_id, set_index FROM training_sets WHERE uuid = $1`,
      [input.set_uuid]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return {
        set_id: Number(existing.rows[0].id),
        training_exercise_id: Number(existing.rows[0].training_exercise_id),
        set_index: existing.rows[0].set_index
      };
    }

    let teId = input.training_exercise_id ?? 0;
    if (!teId) {
      const posRow = await client.query<{ next_pos: string }>(
        `SELECT COALESCE(MAX(position), 0) + 1 AS next_pos
           FROM training_exercises WHERE session_id = $1 AND deleted_at IS NULL`,
        [input.session_id]
      );
      const teIns = await client.query<{ id: string }>(
        `INSERT INTO training_exercises (uuid, session_id, exercise_id, gym_machine_id, position)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4)
         RETURNING id`,
        [input.session_id, input.exercise_id, input.gym_machine_id ?? null, Number(posRow.rows[0].next_pos)]
      );
      teId = Number(teIns.rows[0].id);
    }

    let setIndex = input.set_index ?? 0;
    if (!setIndex) {
      const idxRow = await client.query<{ next_idx: string }>(
        `SELECT COALESCE(MAX(set_index), 0) + 1 AS next_idx
           FROM training_sets WHERE training_exercise_id = $1 AND deleted_at IS NULL`,
        [teId]
      );
      setIndex = Number(idxRow.rows[0].next_idx);
    }

    const setIns = await client.query<{ id: string }>(
      `INSERT INTO training_sets
         (uuid, training_exercise_id, set_index, reps, weight_kg, duration_seconds, distance_m, rpe, is_warmup, without_break, notes, performed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, false), COALESCE($10, false), $11, COALESCE($12::timestamptz, now()))
       RETURNING id`,
      [
        input.set_uuid, teId, setIndex,
        input.reps ?? null, input.weight_kg ?? null,
        input.duration_seconds ?? null, input.distance_m ?? null,
        input.rpe ?? null, input.is_warmup ?? null,
        input.without_break ?? null,
        input.notes ?? null, input.performed_at ?? null
      ]
    );

    await client.query('COMMIT');
    return { set_id: Number(setIns.rows[0].id), training_exercise_id: teId, set_index: setIndex };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export interface AddNoteInput {
  session_id: number;
  scope: 'set' | 'exercise' | 'session';
  target_id?: number;
  text: string;
}

export async function addNote(pool: Pool, input: AddNoteInput): Promise<void> {
  if (input.scope !== 'session' && !input.target_id) {
    throw new Error(`target_id is required for scope='${input.scope}'`);
  }

  if (input.scope === 'session') {
    const r = await pool.query(
      `UPDATE training_sessions
          SET notes = CASE WHEN notes IS NULL THEN $2 ELSE notes || E'\n' || $2 END
        WHERE id = $1`,
      [input.session_id, input.text]
    );
    if ((r.rowCount ?? 0) === 0) throw new Error('note target not found');
    return;
  }

  if (input.scope === 'exercise') {
    const r = await pool.query(
      `UPDATE training_exercises
          SET notes = CASE WHEN notes IS NULL THEN $2 ELSE notes || E'\n' || $2 END
        WHERE id = $1 AND session_id = $3`,
      [input.target_id, input.text, input.session_id]
    );
    if ((r.rowCount ?? 0) === 0) throw new Error('note target not found');
    return;
  }

  // scope === 'set'
  const r = await pool.query(
    `UPDATE training_sets
        SET notes = CASE WHEN notes IS NULL THEN $2 ELSE notes || E'\n' || $2 END
      WHERE id = $1
        AND training_exercise_id IN (SELECT id FROM training_exercises WHERE session_id = $3)`,
    [input.target_id, input.text, input.session_id]
  );
  if ((r.rowCount ?? 0) === 0) throw new Error('note target not found');
}
