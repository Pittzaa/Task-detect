import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import { auditLogs, notifications } from "@/db/schema";
import { enqueue } from "@/jobs/queue";
import type { TenantSession } from "./tenant";

/**
 * E-mails for notifications older than this are not sent when an administrator presses the button: the news is stale. Must not exceed
 * RETENTION.finishedJobDays: "already handed to the sender" is known from the job row, and a purged job must belong to a notification
 * that is already outside this window (a test holds the two together).
 */
export const WAITING_EMAIL_DAYS = 7;
/** One press queues at most this many; the button can be pressed again for the rest. */
export const SEND_BATCH = 500;

const waiting = (s: TenantSession, now: Date) =>
  and(
    eq(notifications.orgId, s.orgId),
    eq(notifications.emailWanted, true),
    isNull(notifications.emailedAt),
    gte(notifications.createdAt, new Date(now.getTime() - WAITING_EMAIL_DAYS * 86_400_000)),
    // already handed to the sender (queued, being retried, deferred by quiet hours, or finally failed or skipped): not "waiting"
    sql`not exists (select 1 from jobs j where j.dedupe_key = 'email:' || ${notifications.id}::text)`,
  );

/**
 * How many notification e-mails are waiting for an administrator to send them (automatic e-mail is off, or older ones from before it was switched on): the recipient had e-mail
 * switched on for the event, nothing has been sent or queued yet, and it is recent. Only people who manage settings may ask.
 */
export async function waitingEmailCount(s: TenantSession, now = new Date()): Promise<number> {
  s.require("org.manage_settings");
  const [r] = await s.tx.select({ n: sql<number>`count(*)::int` }).from(notifications).where(waiting(s, now));
  return r?.n ?? 0;
}

/**
 * Queues the waiting e-mails, oldest first. Each goes through the normal delivery job, so everything is still decided at send time:
 * the recipient must still be a member who can read the task, the text is the current one, quiet hours are respected, and a retry never
 * sends twice (the job key is the same one automatic mode uses, so a second press queues nothing it has already queued).
 */
export async function queueWaitingEmails(s: TenantSession, now = new Date()): Promise<{ queued: number; more: boolean }> {
  s.require("org.manage_settings");
  const rows = await s.tx.select({ id: notifications.id }).from(notifications).where(waiting(s, now)).orderBy(asc(notifications.createdAt), asc(notifications.id)).limit(SEND_BATCH + 1);
  let queued = 0;
  for (const r of rows.slice(0, SEND_BATCH)) {
    const res = await enqueue(s.tx, { kind: "notification.email", orgId: s.orgId, payload: { notificationId: r.id }, dedupeKey: `email:${r.id}`, maxAttempts: 8, runAt: now });
    if (res.created) queued++;
  }
  // The day's deadline e-mails (handlers/deadline.ts) as well: what automatic mode would send, for this organization only, still at most one a
  // person a day. A press within the same minute queues nothing new.
  await enqueue(s.tx, { kind: "deadline.email", orgId: s.orgId, payload: { manual: true }, dedupeKey: `deadline-manual:${s.orgId}:${Math.floor(now.getTime() / 60_000)}`, maxAttempts: 3, runAt: now });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "notification.send_waiting_emails", targetType: "organization", targetId: s.orgId, metadata: { queued } });
  return { queued, more: rows.length > SEND_BATCH };
}
