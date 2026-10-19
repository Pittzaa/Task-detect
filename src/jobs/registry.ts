import { calendarCleanup, calendarReconcile, calendarResync, calendarSyncTask } from "./handlers/calendar";
import { deadlineEmail } from "./handlers/deadline";
import { digestRun } from "./handlers/digest";
import { discordSend } from "./handlers/discord";
import { notificationEmail } from "./handlers/email";
import { outboxProcess } from "./handlers/outbox";
import { remindersScan } from "./handlers/reminders";
import { retentionPurge, storageOrphans } from "./handlers/retention";
import { seriesGenerate } from "./handlers/series";
import type { Registry } from "./worker";

/**
 * What people notice when it is late: notifications, e-mails, Discord messages, reminders, recurring tasks, calendar sync. Everything
 * else (digests, the daily calendar reconcile, retention and orphan sweeps) is housekeeping. Work that follows requests (kick.ts) runs
 * only these, and a cron run does these first, so a short run on a once-a-day schedule still delivers before it tidies up.
 */
export const USER_FACING_KINDS = ["outbox.process", "notification.email", "deadline.email", "discord.send", "reminders.scan", "series.generate", "calendar.sync_task", "calendar.resync", "calendar.cleanup"] as const;

export const registry: Registry = {
  "outbox.process": outboxProcess,
  "notification.email": notificationEmail,
  "discord.send": discordSend,
  "reminders.scan": remindersScan,
  "digest.run": digestRun,
  "deadline.email": deadlineEmail,
  "series.generate": seriesGenerate,
  "calendar.sync_task": calendarSyncTask,
  "calendar.resync": calendarResync,
  "calendar.cleanup": calendarCleanup,
  "calendar.reconcile": calendarReconcile,
  "retention.purge": retentionPurge,
  "storage.orphans": storageOrphans,
};
