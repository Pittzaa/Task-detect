import { and, desc, eq, gte, isNull, ne } from "drizzle-orm";
import { digestLog, memberships, notificationPrefs, notifications, organizations } from "@/db/schema";
import { digestPeriod } from "@/domain/notifications";
import { t } from "@/i18n";
import { logger } from "@/lib/logger";
import { withWorker, withWorkerOrg } from "../context";
import { loadProfiles, renderNotification } from "../notify";
import type { JobHandler } from "../worker";

/**
 * Daily/weekly email digests for people who opted in. At most one digest per user per period (enforced by the
 * digest_log primary key), a digest contains only notifications the user can still see, and anything already
 * emailed individually is left out.
 */
export const digestRun: JobHandler = async (ctx) => {
  const orgs = await withWorker(ctx.db, (tx) => tx.select({ id: organizations.id }).from(organizations).where(isNull(organizations.deletedAt)));
  for (const org of orgs) {
    const prefs = await withWorkerOrg(ctx.db, org.id, (tx) => tx.select().from(notificationPrefs).where(and(eq(notificationPrefs.orgId, org.id), ne(notificationPrefs.digest, "off"))));
    for (const pref of prefs) {
      try {
        await digestForUser(ctx, org.id, pref.userId, pref.digest as "daily" | "weekly");
      } catch (e) {
        logger.error({ orgId: org.id, err: e instanceof Error ? e.constructor.name : "unknown" }, "digest failed for user");
        throw e; // let the job retry; completed users are protected by digest_log
      }
    }
  }
};

async function digestForUser(ctx: Parameters<JobHandler>[0], orgId: string, userId: string, freq: "daily" | "weekly") {
  await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const profile = (await loadProfiles(tx, [userId])).get(userId);
    if (!profile || profile.deleted) return;
    const [m] = await tx.select({ s: memberships.status }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    if (m?.s !== "approved") return;
    const period = digestPeriod(ctx.now(), profile.timezone, freq);
    if (!period) return;

    // Claim the period first; only the claimant sends. A failure below rolls this insert back so a retry can try again.
    const claimed = await tx.insert(digestLog).values({ orgId, userId, periodKey: period.key }).onConflictDoNothing().returning({ k: digestLog.periodKey });
    if (!claimed[0]) return;

    const since = new Date(ctx.now().getTime() - (freq === "daily" ? 2 : 8) * 86_400_000);
    const pending = await tx
      .select()
      .from(notifications)
      .where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId), eq(notifications.inApp, true), isNull(notifications.digestedAt), isNull(notifications.emailedAt), isNull(notifications.readAt), gte(notifications.createdAt, since)))
      .orderBy(desc(notifications.createdAt))
      .limit(100);
    const lines: string[] = [];
    const used: string[] = [];
    for (const n of pending) {
      const r = await renderNotification(tx, orgId, n, profile.locale);
      used.push(n.id);
      if (r.visible) lines.push(`• ${r.text}`);
    }
    if (!lines.length) return;

    const periodLabel = t(profile.locale, freq === "daily" ? "digest.daily" : "digest.weekly");
    await ctx.email.send({
      to: profile.email,
      subject: t(profile.locale, "email.digest.subject", { period: periodLabel, app: t(profile.locale, "app.name") }),
      text: `${t(profile.locale, "digest.intro")}\n\n${lines.join("\n")}\n\n${ctx.appUrl}/o/${orgId}`,
      idempotencyKey: `digest-${orgId}-${userId}-${period.key}`,
    });
    for (const id of used) await tx.update(notifications).set({ digestedAt: ctx.now() }).where(and(eq(notifications.orgId, orgId), eq(notifications.id, id)));
  });
}
