/**
 * Timezone-aware date utilities for converting ISO 8601 timestamps
 * to local dates and computing timezone-aware time boundaries.
 */

/**
 * Extract the local calendar date (YYYY-MM-DD) from an ISO 8601 string.
 *
 * If the string contains a timezone offset (e.g. +02:00, -05:00),
 * the date portion IS the local date — just slice it.
 *
 * If the string is UTC (Z) or has no offset, falls back to computing
 * the local date using the configured timezone.
 */
export function isoToLocalDate(iso: string, timezone: string): string {
  // Check if ISO string has a non-Z offset after the time portion
  // e.g. "2026-04-07T23:30:00+02:00" or "2026-04-07T23:30:00-05:00"
  const tIdx = iso.indexOf('T');
  if (tIdx >= 0) {
    const timePart = iso.slice(tIdx + 1);
    // Has explicit offset (not Z)? The date portion is already local.
    if (/[+-]\d{2}:\d{2}$/.test(timePart) || /[+-]\d{4}$/.test(timePart)) {
      return iso.slice(0, 10);
    }
  }

  // UTC (Z suffix) or no offset — compute local date in configured timezone
  return new Date(iso).toLocaleDateString('sv-SE', { timeZone: timezone });
}

/**
 * Compute a UTC datetime string for a specific local hour on a given date
 * in a given timezone. Used for sleep day boundaries (e.g. 6pm local → UTC).
 *
 * Returns format 'YYYY-MM-DD HH:MM:SS' suitable for SQLite datetime() comparison.
 */
export function localTimeToUtc(
  dateStr: string,
  hour: number,
  timezone: string,
): string {
  // Strategy: use noon UTC as a safe reference to determine the timezone's
  // UTC offset on this date (avoids DST ambiguity — DST never transitions at noon).
  const noonUtc = new Date(dateStr + 'T12:00:00Z');

  // Get the UTC offset in minutes for this timezone on this date
  const offsetMinutes = getUtcOffsetMinutes(noonUtc, timezone);

  // Compute: target local time (dateStr at `hour`:00) minus offset = UTC time
  // local_time = utc_time + offset, so utc_time = local_time - offset
  const localMs = Date.parse(dateStr + 'T00:00:00Z') + hour * 3600_000;
  const utcMs = localMs - offsetMinutes * 60_000;

  // Verify: if DST changed between noon and the target hour, refine
  const utcDate = new Date(utcMs);
  const actualOffset = getUtcOffsetMinutes(utcDate, timezone);
  const refinedMs = actualOffset !== offsetMinutes
    ? localMs - actualOffset * 60_000
    : utcMs;

  const d = new Date(refinedMs);
  const Y = d.getUTCFullYear();
  const M = String(d.getUTCMonth() + 1).padStart(2, '0');
  const D = String(d.getUTCDate()).padStart(2, '0');
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  const s = String(d.getUTCSeconds()).padStart(2, '0');
  return `${Y}-${M}-${D} ${h}:${m}:${s}`;
}

/**
 * Get the UTC offset in minutes for a timezone at a specific instant.
 * Positive = east of UTC (e.g. +120 for UTC+2).
 */
function getUtcOffsetMinutes(instant: Date, timezone: string): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    timeZoneName: 'longOffset',
  });
  const parts = formatter.formatToParts(instant);
  const tzPart = parts.find((p) => p.type === 'timeZoneName');
  if (!tzPart) return 0;

  // Format is "GMT+HH:MM" or "GMT-HH:MM" or "GMT"
  const match = tzPart.value.match(/GMT([+-])(\d{1,2}):?(\d{2})?/);
  if (!match) return 0;

  const sign = match[1] === '+' ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3] ?? '0', 10);
  return sign * (hours * 60 + minutes);
}

/**
 * Return the next calendar day (YYYY-MM-DD) after the given date string.
 */
export function nextDay(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
