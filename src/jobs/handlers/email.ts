import { taskLink } from "@/lib/links";
import { and, eq } from "drizzle-orm";
import { deliveryAttempts, memberships, notificationPrefs, notifications } from "@/db/schema";
import { quietHoursEnd } from "@/domain/notifications";
import { EmailError } from "@/integrations/email";
import { t } from "@/i18n";
import { withWorkerOrg } from "../context";
import { loadProfiles, renderNotification } from "../notify";
import { Deferred, PermanentFailure, type JobHandler } from "../worker";

/**
 * Sends one notification email. Everything is decided at delivery time, not when the job was queued:
 * the recipient must still be an approved member who can still read the task, the text is rendered from the
 * current task state, and quiet hours are applied. A retry therefore can never send stale or unauthorized content.
 */
export const notificationEmail: JobHandler = async (ctx, job) => {
  const orgId = job.orgId;
  const notificationId = job.payload.notificationId;
  if (!orgId || typeof notificationId !== "string") throw new PermanentFailure("MalformedJob");

  // 1) Decide what (if anything) to send, inside a short transaction that holds no network call.
  const plan = await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const [n] = await tx.select().from(notifications).where(and(eq(notifications.orgId, orgId), eq(notifications.id, notificationId)));
    if (!n || n.emailedAt) return { skip: "already_sent_or_missing" as const };
    const profile = (await loadProfiles(tx, [n.userId])).get(n.userId);
    if (!profile || profile.deleted) return { skip: "recipient_gone" as const };
    const [m] = await tx.select({ status: memberships.status }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, n.userId)));
    if (m?.status !== "approved") return { skip: "not_a_member" as const };

    const [prefs] = await tx.select().from(notificationPrefs).where(and(eq(notificationPrefs.orgId, orgId), eq(notificationPrefs.userId, n.userId)));
    if (prefs?.quietStart && prefs.quietEnd) {
      const until = quietHoursEnd(ctx.now(), profile.timezone, prefs.quietStart, prefs.quietEnd);
      if (until) return { defer: until };
    }
    const rendered = await renderNotification(tx, orgId, n, profile.locale);
    if (!rendered.visible) return { skip: "no_access" as const };
    return { send: { to: profile.email, locale: profile.locale, text: rendered.text, taskId: rendered.taskId, userId: n.userId } };
  });

  if ("defer" in plan) throw new Deferred(plan.defer!, "quiet_hours");
  if ("skip" in plan) {
    await withWorkerOrg(ctx.db, orgId, (tx) => tx.insert(deliveryAttempts).values({ orgId, channel: "email", subjectId: notificationId, status: "skipped", detail: plan.skip }));
    return;
  }

  // 2) Send. Idempotency-Key makes a retry after an ambiguous failure safe at the provider.
  const { to, locale, text, taskId } = plan.send;
  const link = taskId ? taskLink(ctx.appUrl, orgId, taskId) : ctx.appUrl;
  try {
    await ctx.email.send({ to, subject: t(locale, "email.notification.subject", { app: t(locale, "app.name"), title: text }), text: `${text}\n\n${link}`, idempotencyKey: `notification-${notificationId}` });
  } catch (e) {
    await withWorkerOrg(ctx.db, orgId, (tx) => tx.insert(deliveryAttempts).values({ orgId, channel: "email", subjectId: notificationId, status: "failed", detail: e instanceof EmailError ? (e.retryable ? "retryable" : "rejected") : "error" }));
    if (e instanceof EmailError && !e.retryable) throw new PermanentFailure("EmailRejected");
    throw e;
  }

  // 3) Record success. If this write fails the job is retried and the provider de-duplicates by idempotency key.
  await withWorkerOrg(ctx.db, orgId, async (tx) => {
    await tx.update(notifications).set({ emailedAt: ctx.now() }).where(and(eq(notifications.orgId, orgId), eq(notifications.id, notificationId)));
    await tx.insert(deliveryAttempts).values({ orgId, channel: "email", subjectId: notificationId, status: "sent" });
  });
};
