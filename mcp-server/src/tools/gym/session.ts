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

// finishSession is implemented in Task 11.
export async function finishSession(_pool: Pool, _input: unknown): Promise<unknown> {
  throw new Error('not implemented');
}
