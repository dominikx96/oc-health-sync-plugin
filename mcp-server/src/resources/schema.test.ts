import { describe, it, expect, afterAll } from 'vitest';
import { createPool } from '../db.js';
import { describeSchema } from './schema.js';

const pool = createPool(process.env.MCP_DATABASE_URL ?? 'postgresql://read_user:read_pw@127.0.0.1:54422/postgres');
afterAll(async () => { await pool.end(); });

describe('describeSchema', () => {
  it('lists known tables, views/functions, and example queries', async () => {
    const md = await describeSchema(pool);
    expect(md).toMatch(/health_samples/);
    expect(md).toMatch(/device_state/);
    expect(md).toMatch(/summary_cache/);
    expect(md).toMatch(/daily_metrics\(/);
    expect(md).toMatch(/detect_anomalies\(/);
    expect(md).toMatch(/example/i);
  });

  it('exposes workout columns and the activity-type enum', async () => {
    const md = await describeSchema(pool);
    expect(md).toMatch(/workout_activity_type_id/);
    expect(md).toMatch(/workout_activity_name/);
    expect(md).toMatch(/workout_duration_seconds/);
    expect(md).toMatch(/workout_energy_kcal/);
    expect(md).toMatch(/workout_distance_m/);
    expect(md).toMatch(/Workout activity types/);
    expect(md).toMatch(/\| 13 \| `cycling` \|/);
    expect(md).toMatch(/\| 37 \| `running` \|/);
    expect(md).toMatch(/cycling workouts in the last 6 months/);
  });

  it('lists the gym tables', async () => {
    const md = await describeSchema(pool);
    expect(md).toMatch(/training_sessions/);
    expect(md).toMatch(/training_sets/);
    expect(md).toMatch(/exercises/);
  });

  it('documents the gym helpers', async () => {
    const md = await describeSchema(pool);
    expect(md).toMatch(/last_sessions_by_type/);
    expect(md).toMatch(/last_exercise_results/);
  });

  it('lists daily_logs and exposes the without_break column on training_sets', async () => {
    const md = await describeSchema(pool);
    expect(md).toMatch(/daily_logs/);
    expect(md).toMatch(/`alcohol`/);
    expect(md).toMatch(/`without_break`/);
    expect(md).toMatch(/health_log_day/);  // mentioned in the prose section
  });

  it('documents the diet domain', async () => {
    const md = await describeSchema(pool);
    expect(md).toContain('diet_catering_meals');
    expect(md).toContain('diet_consumed_day(tz)');
    expect(md).toContain('diet_energy_balance(tz)');
    expect(md).toContain("'VEGAN' = ANY (p.categories)");
  });
});
