import type { Pool } from '../../db.js';

export type SessionType = 'push'|'pull'|'legs'|'upper'|'lower'|'full'|'cardio'|'mobility'|'other';

export interface SessionRow {
  id: number; uuid: string; gym_id: number; type: SessionType;
  started_at: Date; ended_at: Date | null;
  rating: number | null; notes: string | null; source: 'live'|'bulk';
}

export interface StartSessionInput {
  session_uuid: string;
  gym_id: number;
  type: SessionType;
  started_at?: string;
  force?: boolean;
}
export interface StartSessionResult { session_id: number; session_uuid: string }

export async function startSession(pool: Pool, input: StartSessionInput): Promise<StartSessionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotent: same UUID returns the existing row.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM training_sessions WHERE uuid = $1`, [input.session_uuid]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      return { session_id: Number(existing.rows[0].id), session_uuid: input.session_uuid };
    }

    const open = await client.query<{ id: string }>(
      `SELECT id FROM training_sessions WHERE ended_at IS NULL AND deleted_at IS NULL LIMIT 1`
    );
    if (open.rows[0]) {
      if (!input.force) {
        await client.query('ROLLBACK');
        throw new Error('open session exists; pass force=true to auto-finalize it');
      }
      await client.query(
        `UPDATE training_sessions
            SET ended_at = now(),
                notes = COALESCE(notes || E'\n','') || 'auto-closed'
          WHERE id = $1`,
        [open.rows[0].id]
      );
    }

    const r = await client.query<{ id: string }>(
      `INSERT INTO training_sessions (uuid, gym_id, type, started_at, source)
       VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), 'live')
       RETURNING id`,
      [input.session_uuid, input.gym_id, input.type, input.started_at ?? null]
    );
    await client.query('COMMIT');
    return { session_id: Number(r.rows[0].id), session_uuid: input.session_uuid };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function currentSession(pool: Pool): Promise<{ row: SessionRow | null }> {
  const r = await pool.query<SessionRow>(
    `SELECT id::int, uuid, gym_id::int, type, started_at, ended_at, rating, notes, source
       FROM current_open_session LIMIT 1`
  );
  return { row: r.rows[0] ?? null };
}

export interface FinishSessionInput {
  session_id: number;
  rating?: number;
  notes?: string;
  ended_at?: string;
}
export interface FinishSessionResult {
  summary: {
    session_id: number;
    started_at: Date;
    ended_at: Date;
    rating: number | null;
    total_sets: number;
    total_volume_kg: number;
  }
}

export async function finishSession(pool: Pool, input: FinishSessionInput): Promise<FinishSessionResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const status = await client.query<{ ended_at: Date | null }>(
      `SELECT ended_at FROM training_sessions WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [input.session_id]
    );
    if (!status.rows[0]) {
      await client.query('ROLLBACK');
      throw new Error(`session ${input.session_id} not found`);
    }
    if (status.rows[0].ended_at) {
      await client.query('ROLLBACK');
      throw new Error(`session ${input.session_id} already finished`);
    }

    const upd = await client.query<{ id: string; started_at: Date; ended_at: Date; rating: number | null }>(
      `UPDATE training_sessions
          SET ended_at = COALESCE($2::timestamptz, now()),
              rating   = COALESCE($3, rating),
              notes    = CASE WHEN $4::text IS NULL THEN notes
                              WHEN notes IS NULL THEN $4
                              ELSE notes || E'\n' || $4 END
        WHERE id = $1
        RETURNING id, started_at, ended_at, rating`,
      [input.session_id, input.ended_at ?? null, input.rating ?? null, input.notes ?? null]
    );

    const totals = await client.query<{ total_sets: string; total_volume_kg: string }>(
      `SELECT COUNT(ts.id)                                              AS total_sets,
              COALESCE(SUM(ts.weight_kg * ts.reps), 0)::float8           AS total_volume_kg
         FROM training_exercises te
         LEFT JOIN training_sets ts ON ts.training_exercise_id = te.id AND ts.deleted_at IS NULL
        WHERE te.session_id = $1 AND te.deleted_at IS NULL`,
      [input.session_id]
    );

    await client.query('COMMIT');

    return {
      summary: {
        session_id:      Number(upd.rows[0].id),
        started_at:      upd.rows[0].started_at,
        ended_at:        upd.rows[0].ended_at,
        rating:          upd.rows[0].rating,
        total_sets:      Number(totals.rows[0].total_sets),
        total_volume_kg: Number(totals.rows[0].total_volume_kg)
      }
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
