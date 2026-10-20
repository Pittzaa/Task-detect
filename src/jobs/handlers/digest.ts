import { and, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { digestLog, memberships, notificationPrefs, notifications, organizations, tasks } from "@/db/schema";
import { digestPeriod, quietHoursEnd } from "@/domain/notifications";
import { asEmailSchedule, emailRunAllowed } from "@/domain/email-schedule";
import { addDays } from "@/domain/time";
import { renderEmail } from "@/integrations/email/templates";
import { t } from "@/i18n";
import { logger } from "@/lib/logger";
import { myTasksLink } from "@/lib/links";
import { withWorker, withWorkerOrg } from "../context";
import { fromNameFor } from "@/domain/app-name";
import { brandOf } from "@/server/brand";
import { DEADLINE_SEND_HOUR } from "./deadline";
import { enabledUsers, loadProfiles, renderNotifications } from "../notify";
import { Deferred, type JobHandler } from "../worker";

/**
 * Daily/weekly email digests for people who opted in. At most one digest per user per period (enforced by the
 * digest_log primary key), a digest contains only notifications the user can still see, and anything already
 * emailed individually is left out.
 */
export const digestRun: JobHandler = async (ctx) => {
  // daily mode (a once-a-day cron) serves its organizations only inside the 23:00 window, instant mode whenever this runs
  const orgs = (await withWorker(ctx.db, (tx) => tx.select({ id: organizations.id, schedule: organizations.emailSchedule }).from(organizations).where(and(isNull(organizations.deletedAt), eq(organizations.autoEmail, true))))).filter((o) => emailRunAllowed(asEmailSchedule(o.schedule), ctx.now()));
  for (const org of orgs) {
    const prefs = await withWorkerOrg(ctx.db, org.id, (tx) => tx.select().from(notificationPrefs).where(and(eq(notificationPrefs.orgId, org.id), ne(notificationPrefs.digest, "off"))));
    for (const pref of prefs) {
      if (ctx.deadline && Date.now() > ctx.deadline) throw new Deferred(new Date(Date.now() + 60_000), "digest run out of time"); // the rest next time; everyone served is protected by digest_log
      try {
        await digestForUser(ctx, org.id, pref.userId, pref.digest as "daily" | "weekly", pref);
      } catch (e) {
        logger.error({ orgId: org.id, err: e instanceof Error ? e.constructor.name : "unknown" }, "digest failed for user");
        throw e; // let the job retry; completed users are protected by digest_log
      }
    }
  }
};

async function digestForUser(ctx: Parameters<JobHandler>[0], orgId: string, userId: string, freq: "daily" | "weekly", pref: { quietStart: string | null; quietEnd: string | null }) {
  await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const profile = (await loadProfiles(tx, [userId])).get(userId);
    if (!profile || profile.deleted) return;
    const [m] = await tx.select({ s: memberships.status }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    if (m?.s !== "approved") return;
    // an e-mail like any other: not during the person's quiet hours (a later run sends it, the period is not used up)
    if (pref.quietStart && pref.quietEnd && quietHoursEnd(ctx.now(), profile.timezone, pref.quietStart, pref.quietEnd)) return;
    const period = digestPeriod(ctx.now(), profile.timezone, freq);

    // Claim the period first; only the claimant sends. A failure below rolls this insert back so a retry can try again.
    const claimed = await tx.insert(digestLog).values({ orgId, userId, periodKey: period.key }).onConflictDoNothing().returning({ k: digestLog.periodKey });
    if (!claimed[0]) return;

    // wider than the period, so a period that a clock change made a run skip is still covered by the next one; digestedAt prevents repeats
    const since = new Date(ctx.now().getTime() - (freq === "daily" ? 3 : 9) * 86_400_000);
    const pending = await tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), eq(notifications.inApp, true), isNull(notifications.digestedAt), isNull(notifications.emailedAt), eq(notifications.emailWanted, false), isNull(notifications.readAt), gte(notifications.createdAt, since)))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    const lines: string[] = [];
    const used: string[] = [];
    const rendered = await renderNotifications(tx, orgId, pending, profile.locale);
    const covered = await coveredByDeadlineEmail(tx, orgId, userId, profile.timezone, ctx.now(), pending);
    pending.forEach((n, i) => {
      used.push(n.id);
      if (covered.has(n.id)) return; // the deadline e-mail lists this task; the digest does not say it twice
      if (rendered[i]!.visible) lines.push(rendered[i]!.text);
    });
    if (!lines.length) return;

    const periodLabel = t(profile.locale, freq === "daily" ? "digest.daily" : "digest.weekly");
    const app = await brandOf(tx, orgId);
    const mail = renderEmail({
      locale: profile.locale,
      app,
      heading: t(profile.locale, "email.digest.heading", { period: periodLabel }),
      intro: [t(profile.locale, "digest.intro")],
      list: lines,
      button: { label: t(profile.locale, "email.digest.button", { app }), url: myTasksLink(ctx.appUrl, orgId) },
    });
    await ctx.email.send({
      to: profile.email,
      fromName: fromNameFor(app),
      subject: t(profile.locale, "email.digest.subject", { period: periodLabel, app }),
      text: mail.text,
      html: mail.html,
      idempotencyKey: `digest-${orgId}-${userId}-${period.key}`,
    });
    for (const id of used) await tx.update(notifications).set({ digestedAt: ctx.now() }).where(and(eq(notifications.orgId, orgId), eq(notifications.id, id)));
  });
}

/**
 * The due-soon and overdue notifications whose task the person's deadline e-mail (handlers/deadline.ts) lists today: still unfinished, overdue
 * or due today/tomorrow, and the person has e-mail switched on for that kind. A digest repeating those would say everything twice. Reminders set
 * further ahead, and anything the person switched e-mail off for, stay in the digest.
 */
async function coveredByDeadlineEmail(tx: Parameters<Parameters<typeof withWorkerOrg>[2]>[0], orgId: string, userId: string, tz: string, now: Date, pending: { id: string; type: string; taskId: string | null }[]): Promise<Set<string>> {
  const rows = pending.filter((n) => (n.type === "task.overdue" || n.type === "task.due_soon") && n.taskId);
  if (!rows.length) return new Set();
  const overdueOn = (await enabledUsers(tx, orgId, [userId], "email", "task.overdue")).has(userId);
  const soonOn = (await enabledUsers(tx, orgId, [userId], "email", "task.due_soon")).has(userId);
  const found = await tx.select({ id: tasks.id, status: tasks.status, dueDate: tasks.dueDate, deletedAt: tasks.deletedAt }).from(tasks).where(and(eq(tasks.orgId, orgId), inArray(tasks.id, [...new Set(rows.map((n) => n.taskId!))])));
  const byId = new Map(found.map((r) => [r.id, r]));
  // the same day the deadline e-mail judges by (its 09:00 period's date, handlers/deadline.ts), not the calendar date right now: between midnight
  // and 09:00 the two differ, and a reminder must not be dropped here for a task that e-mail will not list yet
  const today = digestPeriod(now, tz, "daily", DEADLINE_SEND_HOUR).key.slice("daily:".length);
  const tomorrow = addDays(today, 1);
  const out = new Set<string>();
  for (const n of rows) {
    const task = byId.get(n.taskId!);
    if (!task || task.deletedAt || !task.dueDate || task.status === "done" || task.status === "cancelled") continue;
    if ((task.dueDate < today && overdueOn) || ((task.dueDate === today || task.dueDate === tomorrow) && soonOn)) out.add(n.id);
  }
  return out;
}
