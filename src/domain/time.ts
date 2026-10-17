/**
 * Date and time-zone helpers. Conventions used across the app:
 *  - instants (created_at, completed_at, reminders) are UTC `Date`s;
 *  - calendar dates (start/due/occurrence) are "YYYY-MM-DD" strings with no zone;
 *  - a user's IANA zone decides which calendar date "today" is and when "09:00" happens.
 */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const partsCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string) {
  let f = partsCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    partsCache.set(tz, f);
  }
  return f;
}

/** Offset of `tz` from UTC at the given instant, in minutes (local = utc + offset). */
export function tzOffsetMinutes(utcMs: number, tz: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(new Date(utcMs))) if (part.type !== "literal") p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return Math.round((asUtc - Math.floor(utcMs / 1000) * 1000) / 60000);
}

/**
 * The UTC instant at which the wall clock in `tz` reads the given local date and time.
 *  - A local time that does not exist (spring-forward gap) resolves forward to the first valid instant.
 *  - A local time that occurs twice (fall-back overlap) resolves to the first occurrence.
 */
export function localToUtc(date: string, hour: number, minute: number, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  // Offsets in force a day before and a day after the requested wall time bracket any transition.
  const before = tzOffsetMinutes(wall - 86_400_000, tz);
  const after = tzOffsetMinutes(wall + 86_400_000, tz);
  const c1 = wall - before * 60_000;
  const c2 = wall - after * 60_000;
  const ok1 = tzOffsetMinutes(c1, tz) === before;
  const ok2 = tzOffsetMinutes(c2, tz) === after;
  if (ok1 && ok2) return new Date(Math.min(c1, c2)); // overlap (or no transition): first occurrence
  if (ok1) return new Date(c1);
  if (ok2) return new Date(c2);
  return new Date(c1); // gap: the pre-transition offset lands just after the gap
}

/** Calendar date ("YYYY-MM-DD") of an instant in `tz`. */
export function dateInZone(instant: Date, tz: string): string {
  const p: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instant)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day}`;
}

export const todayIn = (tz: string, now = new Date()) => dateInZone(now, tz);

const toMs = (date: string) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date: string, n: number) => fromMs(toMs(date) + n * 86_400_000);
export const diffDays = (a: string, b: string) => Math.round((toMs(a) - toMs(b)) / 86_400_000);
/** 0 = Sunday ... 6 = Saturday */
export const weekdayOf = (date: string) => new Date(toMs(date)).getUTCDay();
export const daysInMonth = (year: number, month1: number) => new Date(Date.UTC(year, month1, 0)).getUTCDate();

/** When to remind about a task: `daysBefore` days before the due date at `hour`:00 in the recipient's zone. */
export function reminderInstant(dueDate: string, daysBefore: number, tz: string, hour = 9): Date {
  return localToUtc(addDays(dueDate, -daysBefore), hour, 0, tz);
}

/**
 * Display helpers. Thai uses the Buddhist Era calendar (the default for the `th-TH` locale and the
 * convention in Thailand); English uses the Gregorian calendar.
 */
export function formatDate(date: string, locale: "th" | "en", opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" }): string {
  return new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { ...opts, timeZone: "UTC" }).format(new Date(toMs(date)));
}

export function formatInstant(instant: Date, locale: "th" | "en", tz: string, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" }): string {
  return new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { ...opts, timeZone: tz }).format(instant);
}
