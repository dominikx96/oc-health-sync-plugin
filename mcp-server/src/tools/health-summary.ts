import type { Pool } from '../db.js';
import { renderDaily, renderWeekly, renderMonthly, type DailyRow } from './templates.js';

export type Period = 'day' | 'week' | 'month';

export interface HealthSummaryInput {
  period: Period;
  date?:  string;  // ISO date (YYYY-MM-DD); defaults to today in tz
  tz?:    string;  // IANA tz; defaults to UTC
}

function todayInTz(tz: string): string {
  const d = new Date();
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d); // en-CA gives YYYY-MM-DD
}

function startOfWeek(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  // ISO week starts Monday (1) – shift Sunday (0) back 6.
  const diff = (dow + 6) % 7;
  d.setUTCDate(d.getUTCDate() - diff);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

function cacheKey(period: Period, date: string, tz: string): string {
  if (period === 'day')   return `daily:${date}:${tz}`;
  if (period === 'week')  return `weekly:${startOfWeek(date)}:${tz}`;
  return `monthly:${date.slice(0, 7)}:${tz}`;
}

async function getCached(pool: Pool, key: string): Promise<string | null> {
  const r = await pool.query<{ markdown: string }>(
    `SELECT markdown FROM summary_cache WHERE cache_key = $1 AND invalidated = false`,
    [key]
  );
  return r.rows[0]?.markdown ?? null;
}

async function putCached(pool: Pool, key: string, markdown: string): Promise<void> {
  await pool.query(
    `INSERT INTO summary_cache (cache_key, markdown, invalidated)
     VALUES ($1, $2, false)
     ON CONFLICT (cache_key) DO UPDATE SET
       markdown     = EXCLUDED.markdown,
       generated_at = now(),
       invalidated  = false`,
    [key, markdown]
  );
}

// node-postgres returns NUMERIC columns as strings to avoid precision loss.
// Coerce all numeric fields to JS numbers here.
function coerceRow(row: any): DailyRow | undefined {
  if (!row) return undefined;
  return {
    day:                row.day,
    total_steps:        row.total_steps        === null ? null : Number(row.total_steps),
    avg_heart_rate:     row.avg_heart_rate     === null ? null : Number(row.avg_heart_rate),
    resting_heart_rate: row.resting_heart_rate === null ? null : Number(row.resting_heart_rate),
    hrv_mean:           row.hrv_mean           === null ? null : Number(row.hrv_mean),
    sleep_minutes:      row.sleep_minutes      === null ? null : Number(row.sleep_minutes),
    workout_count:      Number(row.workout_count ?? 0)
  };
}

export async function healthSummary(pool: Pool, input: HealthSummaryInput): Promise<string> {
  const tz   = input.tz   ?? 'UTC';
  const date = input.date ?? todayInTz(tz);
  const key  = cacheKey(input.period, date, tz);

  const cached = await getCached(pool, key);
  if (cached) return cached;

  let markdown: string;
  if (input.period === 'day') {
    const r = await pool.query(
      `SELECT * FROM daily_metrics($1) WHERE day = $2`,
      [tz, date]
    );
    markdown = renderDaily(date, coerceRow(r.rows[0]));
  } else if (input.period === 'week') {
    const ws = startOfWeek(date);
    const r = await pool.query(
      `SELECT week_start AS day, total_steps, avg_heart_rate, resting_heart_rate, hrv_mean, sleep_minutes, workout_count
         FROM weekly_metrics($1) WHERE week_start = $2`,
      [tz, ws]
    );
    markdown = renderWeekly(ws, coerceRow(r.rows[0]));
  } else {
    const ms = startOfMonth(date);
    const r = await pool.query(
      `SELECT month_start AS day, total_steps, avg_heart_rate, resting_heart_rate, hrv_mean, sleep_minutes, workout_count
         FROM monthly_metrics($1) WHERE month_start = $2`,
      [tz, ms]
    );
    markdown = renderMonthly(ms, coerceRow(r.rows[0]));
  }

  await putCached(pool, key, markdown);
  return markdown;
}
