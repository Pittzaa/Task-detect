import { addDays, dateInZone, localToUtc } from "./time";

export const NOTIFICATION_TYPES = [
  "task.assigned",
  "task.unassigned",
  "task.commented",
  "task.mentioned",
  "task.status_changed",
  "task.priority_changed",
  "task.due_soon",
  "task.overdue",
  "task.dependency_changed",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const CHANNELS = ["in_app", "email"] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * Defaults when a user has not chosen. In-app shows everything relevant; email is limited to things that
 * usually need action so inboxes are not flooded.
 */
const EMAIL_DEFAULT_ON: readonly NotificationType[] = ["task.assigned", "task.mentioned", "task.due_soon", "task.overdue"];
export const defaultEnabled = (channel: Channel, type: NotificationType): boolean => (channel === "in_app" ? true : EMAIL_DEFAULT_ON.includes(type));

export const isNotificationType = (v: string): v is NotificationType => (NOTIFICATION_TYPES as readonly string[]).includes(v);

/** Events a Discord destination can subscribe to. */
export const DISCORD_EVENTS = ["task.created", "task.assigned", "task.commented", "task.status_changed", "task.priority_changed", "task.due_soon", "task.overdue"] as const;
export type DiscordEvent = (typeof DISCORD_EVENTS)[number];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isHHMM = (v: string) => HHMM.test(v);

/**
 * If `now` falls inside the user's quiet hours, returns the instant they end; otherwise null.
 * Windows may cross midnight (22:00 -> 07:00). Evaluated in the user's own time zone, so it follows DST.
 */
export function quietHoursEnd(now: Date, tz: string, start: string, end: string): Date | null {
  if (!HHMM.test(start) || !HHMM.test(end) || start === end) return null;
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const [lh, lm] = local.split(":").map(Number) as [number, number];
  const t = lh * 60 + lm;
  const [sh, sm] = start.split(":").map(Number) as [number, number];
  const [eh, em] = end.split(":").map(Number) as [number, number];
  const s = sh * 60 + sm;
  const e = eh * 60 + em;
  const crossesMidnight = s > e;
  const inside = crossesMidnight ? t >= s || t < e : t >= s && t < e;
  if (!inside) return null;
  const today = dateInZone(now, tz);
  const endDate = crossesMidnight && t >= s ? addDays(today, 1) : today;
  return localToUtc(endDate, eh, em, tz);
}

/**
 * The digest period a moment belongs to: the latest one whose send time (`sendHour`, the user's local time) has passed. Before today's
 * send time that is yesterday's (daily) or, on a Monday morning, last week's (weekly). So a scheduler that runs once a day at a fixed hour
 * (Vercel Hobby) still serves every period of every time zone, a little late where that hour is before 08:00 local. digest_log keeps
 * it to one e-mail per period.
 */
export function digestPeriod(now: Date, tz: string, frequency: "daily" | "weekly", sendHour = 8): { key: string; startsAt: Date } {
  const today = dateInZone(now, tz);
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(now));
  const day = hour < sendHour ? addDays(today, -1) : today; // the local date of the latest send time that has passed
  if (frequency === "daily") return { key: `daily:${day}`, startsAt: localToUtc(day, sendHour, 0, tz) };
  // weekly: Monday at sendHour; the rest of the week, up to the next Monday's send time, belongs to that Monday's period
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  const monday = addDays(day, -((weekday + 6) % 7));
  return { key: `weekly:${monday}`, startsAt: localToUtc(monday, sendHour, 0, tz) };
}
