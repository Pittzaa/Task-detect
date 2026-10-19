/**
 * "Daily" e-mail mode (Settings -> Notifications): the organization's e-mails are held for 23:00 Thai time, the hour a once-a-day cron (Vercel
 * Hobby, vercel.json) runs. Thai time is UTC+7 all year (no daylight saving), so plain arithmetic is exact.
 */
export type EmailSchedule = "instant" | "daily";
export const EMAIL_SCHEDULES: readonly EmailSchedule[] = ["instant", "daily"];

const BANGKOK_OFFSET_MS = 7 * 3_600_000;
/** The hour (Thai time) from which daily-mode e-mails go out. */
export const DAILY_EMAIL_HOUR = 23;
/**
 * A run that comes late still sends what is due: the window is open from 23:00 until this hour the next morning (exclusive). Nobody is
 * e-mailed twice by it (every e-mail has a claim or a job key); it only means a cron that fired an hour or two late still delivers.
 */
export const DAILY_EMAIL_WINDOW_END_HOUR = 4;

const thaiClock = (now: Date) => new Date(now.getTime() + BANGKOK_OFFSET_MS);

/** True from 23:00 to 03:59 Thai time. */
export function inDailyEmailWindow(now: Date): boolean {
  const h = thaiClock(now).getUTCHours();
  return h >= DAILY_EMAIL_HOUR || h < DAILY_EMAIL_WINDOW_END_HOUR;
}

/** When a daily-mode e-mail created at `now` is sent: right away inside the window, otherwise at the coming 23:00 Thai time. */
export function nextDailyEmailAt(now: Date): Date {
  if (inDailyEmailWindow(now)) return now;
  const local = thaiClock(now);
  // outside the window the local hour is 04..22, so 23:00 of the same local date is ahead
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), DAILY_EMAIL_HOUR) - BANGKOK_OFFSET_MS);
}

/** Whether the organization's scheduled e-mail work (deadline e-mails, digests) may run at `now`. Instant mode always may. */
export function emailRunAllowed(schedule: EmailSchedule, now: Date): boolean {
  return schedule === "instant" || inDailyEmailWindow(now);
}

export const asEmailSchedule = (v: unknown): EmailSchedule => (v === "daily" ? "daily" : "instant");
