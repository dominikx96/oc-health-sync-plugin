/**
 * Shared timezone-aware date utilities.
 *
 * All functions that need "today" accept a timezone string (IANA, e.g. "Europe/Warsaw").
 * Consolidates the dateRange / formatDate helpers that were duplicated across files.
 */

/**
 * Returns today's date (YYYY-MM-DD) in the given timezone.
 * Falls back to system timezone if not provided.
 */
export function todayIn(timezone?: string): string {
  // 'sv-SE' locale conveniently formats as YYYY-MM-DD
  return new Date().toLocaleDateString('sv-SE', {
    timeZone: timezone,
  });
}

/**
 * Returns a date N days before today, in the given timezone.
 */
export function daysAgo(n: number, timezone?: string): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('sv-SE', { timeZone: timezone });
}

/**
 * Returns an array of YYYY-MM-DD strings from `from` to `to` (inclusive).
 */
export function dateRange(from: string, to: string): string[] {
  const dates: string[] = [];
  const current = new Date(from + 'T00:00:00');
  const end = new Date(to + 'T00:00:00');
  while (current <= end) {
    dates.push(current.toISOString().slice(0, 10));
    current.setDate(current.getDate() + 1);
  }
  return dates;
}

/**
 * Returns the date 7 days before the given date string.
 */
export function sevenDaysBefore(date: string): string {
  const d = new Date(date + 'T00:00:00');
  d.setDate(d.getDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns the day name (e.g. "Monday") for a date string.
 */
export function getDayName(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long' });
}
