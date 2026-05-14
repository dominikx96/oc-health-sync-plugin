import { z } from 'zod';
import type { Pool } from '../../db.js';

const SetSchema = z.object({
  set_uuid:         z.string().min(1),
  set_index:        z.number().int().positive().optional(),
  reps:             z.number().int().optional(),
  weight_kg:        z.number().optional(),
  duration_seconds: z.number().optional(),
  distance_m:       z.number().optional(),
  rpe:              z.number().int().min(1).max(10).optional(),
  is_warmup:        z.boolean().optional(),
  without_break:    z.boolean().optional(),
  notes:            z.string().nullable().optional(),
  performed_at:     z.string().optional()
}).refine(
  (v) => v.reps != null || v.duration_seconds != null || v.distance_m != null,
  { message: 'each set requires at least one of reps/duration_seconds/distance_m' }
);

const ExerciseSchema = z.object({
  exercise_slug:  z.string().min(1),
  exercise_uuid:  z.string().min(1),
  machine:        z.object({
    manufacturer: z.string().nullable().optional(),
    model:        z.string().nullable().optional(),
    label:        z.string().nullable().optional()
  }).optional(),
  notes:          z.string().nullable().optional(),
  sets:           z.array(SetSchema).min(1)
});

export const BulkPayloadSchema = z.object({
  session_uuid: z.string().min(1),
  gym_slug:     z.string().min(1),
  type:         z.enum(['push','pull','legs','upper','lower','full','cardio','mobility','other']),
  started_at:   z.string(),
  ended_at:     z.string(),
  rating:       z.number().int().min(1).max(10).nullable().optional(),
  notes:        z.string().nullable().optional(),
  exercises:    z.array(ExerciseSchema).min(1)
});

export type BulkPayload = z.infer<typeof BulkPayloadSchema>;

export interface BulkResult {
  session_id: number;
  summary: { total_sets: number; total_volume_kg: number };
}

export async function submitSessionBulk(pool: Pool, raw: unknown): Promise<BulkResult> {
  const payload = BulkPayloadSchema.parse(raw);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Idempotent on session_uuid: if the session already exists, recompute and return.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM training_sessions WHERE uuid = $1`, [payload.session_uuid]
    );
    if (existing.rows[0]) {
      const totals = await client.query<{ total_sets: string; total_volume_kg: string }>(
        `SELECT COUNT(ts.id) AS total_sets,
                COALESCE(SUM(ts.weight_kg * ts.reps), 0)::float8 AS total_volume_kg
           FROM training_exercises te
           LEFT JOIN training_sets ts ON ts.training_exercise_id = te.id AND ts.deleted_at IS NULL
          WHERE te.session_id = $1 AND te.deleted_at IS NULL`,
        [existing.rows[0].id]
      );
      await client.query('COMMIT');
      return {
        session_id: Number(existing.rows[0].id),
        summary: {
          total_sets:      Number(totals.rows[0].total_sets),
          total_volume_kg: Number(totals.rows[0].total_volume_kg)
        }
      };
    }

    // Resolve gym slug → gym_id (strict: no auto-creation).
    const gym = await client.query<{ id: string }>(
      `SELECT id FROM gyms WHERE slug = $1 AND deleted_at IS NULL`,
      [payload.gym_slug]
    );
    if (!gym.rows[0]) {
      await client.query('ROLLBACK');
      throw new Error(`unknown gym slug: ${payload.gym_slug}`);
    }
    const gymId = Number(gym.rows[0].id);

    // Resolve all exercise slugs in a single query so every unknown is reported at once.
    const slugs = payload.exercises.map((e) => e.exercise_slug);
    const exRows = await client.query<{ slug: string; id: string }>(
      `SELECT slug, id FROM exercises WHERE slug = ANY($1) AND deleted_at IS NULL`,
      [slugs]
    );
    const exBySlug = new Map(exRows.rows.map((r) => [r.slug, Number(r.id)]));
    const unknown = slugs.filter((s) => !exBySlug.has(s));
    if (unknown.length > 0) {
      await client.query('ROLLBACK');
      throw new Error(`unknown exercise slug(s): ${unknown.join(', ')}`);
    }

    // Insert training_sessions row.
    const sIns = await client.query<{ id: string }>(
      `INSERT INTO training_sessions (uuid, gym_id, type, started_at, ended_at, rating, notes, source)
       VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6, $7, 'bulk')
       RETURNING id`,
      [
        payload.session_uuid, gymId, payload.type,
        payload.started_at, payload.ended_at,
        payload.rating ?? null, payload.notes ?? null
      ]
    );
    const sessionId = Number(sIns.rows[0].id);

    // Phase 1: resolve all machine references — collect every failure before throwing.
    const machineErrors: string[] = [];
    const resolvedMachineIds: (number | null)[] = [];

    for (let i = 0; i < payload.exercises.length; i++) {
      const ex         = payload.exercises[i];
      const exerciseId = exBySlug.get(ex.exercise_slug)!;

      if (ex.machine) {
        const m = await client.query<{ id: string }>(
          `SELECT id FROM gym_machines
            WHERE deleted_at IS NULL
              AND gym_id      = $1
              AND exercise_id = $2
              AND COALESCE(manufacturer, '') = COALESCE($3::text, '')
              AND COALESCE(model, '')        = COALESCE($4::text, '')`,
          [gymId, exerciseId, ex.machine.manufacturer ?? null, ex.machine.model ?? null]
        );
        if (!m.rows[0]) {
          machineErrors.push(
            `gym=${payload.gym_slug} exercise=${ex.exercise_slug} ` +
            `manufacturer=${ex.machine.manufacturer ?? 'NULL'} model=${ex.machine.model ?? 'NULL'}`
          );
          resolvedMachineIds.push(null);
        } else {
          resolvedMachineIds.push(Number(m.rows[0].id));
        }
      } else {
        resolvedMachineIds.push(null);
      }
    }

    if (machineErrors.length > 0) {
      await client.query('ROLLBACK');
      throw new Error(`unknown gym_machine(s): ${machineErrors.join('; ')}`);
    }

    // Phase 2: all machines resolved — do the actual INSERTs.
    let totalSets   = 0;
    let totalVolume = 0;

    for (let i = 0; i < payload.exercises.length; i++) {
      const ex         = payload.exercises[i];
      const exerciseId = exBySlug.get(ex.exercise_slug)!;
      const machineId  = resolvedMachineIds[i];

      // Insert training_exercises row.
      const teIns = await client.query<{ id: string }>(
        `INSERT INTO training_exercises (uuid, session_id, exercise_id, gym_machine_id, position, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [ex.exercise_uuid, sessionId, exerciseId, machineId, i + 1, ex.notes ?? null]
      );
      const teId = Number(teIns.rows[0].id);

      // Insert each set.
      for (let j = 0; j < ex.sets.length; j++) {
        const st = ex.sets[j];
        await client.query(
          `INSERT INTO training_sets
             (uuid, training_exercise_id, set_index, reps, weight_kg,
              duration_seconds, distance_m, rpe, is_warmup, without_break, notes, performed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, false), COALESCE($10, false), $11,
                   COALESCE($12::timestamptz, $13::timestamptz))`,
          [
            st.set_uuid, teId, st.set_index ?? (j + 1),
            st.reps ?? null, st.weight_kg ?? null,
            st.duration_seconds ?? null, st.distance_m ?? null,
            st.rpe ?? null, st.is_warmup ?? null,
            st.without_break ?? null,
            st.notes ?? null, st.performed_at ?? null, payload.started_at
          ]
        );
        totalSets += 1;
        if (st.reps != null && st.weight_kg != null) {
          totalVolume += st.reps * st.weight_kg;
        }
      }
    }

    await client.query('COMMIT');
    return {
      session_id: sessionId,
      summary: { total_sets: totalSets, total_volume_kg: totalVolume }
    };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
