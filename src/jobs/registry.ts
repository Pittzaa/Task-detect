import { calendarCleanup, calendarReconcile, calendarResync, calendarSyncTask } from "./handlers/calendar";
import { digestRun } from "./handlers/digest";
import { discordSend } from "./handlers/discord";
import { notificationEmail } from "./handlers/email";
import { outboxProcess } from "./handlers/outbox";
import { remindersScan } from "./handlers/reminders";
import { retentionPurge, storageOrphans } from "./handlers/retention";
import { seriesGenerate } from "./handlers/series";
import type { Registry } from "./worker";

export const registry: Registry = {
  "outbox.process": outboxProcess,
  "notification.email": notificationEmail,
  "discord.send": discordSend,
  "reminders.scan": remindersScan,
  "digest.run": digestRun,
  "series.generate": seriesGenerate,
  "calendar.sync_task": calendarSyncTask,
  "calendar.resync": calendarResync,
  "calendar.cleanup": calendarCleanup,
  "calendar.reconcile": calendarReconcile,
  "retention.purge": retentionPurge,
  "storage.orphans": storageOrphans,
};
