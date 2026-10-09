// Timestamps in the formats the bb helpers write (see docs/runtime-contract.md).

const pad = (n: number, width = 2): string => String(n).padStart(width, "0");

/**
 * ISO-8601 UTC in the shape of Java `ISO_INSTANT` at millisecond precision (fraction omitted
 * when zero). bb may emit nanoseconds; readers must parse, never compare these as strings.
 */
export function isoInstant(date: Date = new Date()): string {
  const base =
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
  const ms = date.getUTCMilliseconds();
  return ms === 0 ? `${base}Z` : `${base}.${pad(ms, 3)}Z`;
}

/** `yyyyMMdd'T'HHmmss'Z'` in UTC, used in handoff ids and filenames. */
export function idTimestamp(date: Date = new Date()): string {
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}
