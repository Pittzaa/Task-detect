import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  appRateLimits, attachments, authRateLimits, authSessions, authVerifications, auditLogs, commentMentions, comments, customFieldValues, deliveryAttempts,
  digestLog, notifications, oauthStates, organizations, savedViews, taskActivity, taskAssignees, taskDependencies, taskLabels, tasks,
} from "@/db/schema";
import { cutoffDays, cutoffHours, PURGE_BATCH, RETENTION } from "@/domain/retention";
import { errorClassOf, Deferred, type JobHandler } from "../worker";
import { logger } from "@/lib/logger";
import { withWorker, withWorkerOrg } from "../context";

/** Raw SQL through the shared Db type: the driver-specific result shape is the same for node-postgres and Neon. */
async function run<T extends Record<string, unknown> = Record<string, unknown>>(tx: Tx, query: ReturnType<typeof sql>): Promise<{ rows: T[]; rowCount: number }> {
  const r = (await tx.execute(query)) as unknown as { rows: T[]; rowCount: number | null };
  return { rows: r.rows, rowCount: r.rowCount ?? 0 };
}

/** One scheduled run is bounded; if work remains the job defers itself instead of holding a function open. */
const BUDGET_MS = 40_000;

export interface PurgeReport {
  auditLogs: number;
  jobs: number;
  outbox: number;
  authRows: number;
  tasks: number;
  attachments: number;
  objects: number;
  objectFailures: number;
  notifications: number;
  other: number;
  skippedWithCalendarLinks: number;
  more: boolean;
}

const emptyReport = (): PurgeReport => ({ auditLogs: 0, jobs: 0, outbox: 0, authRows: 0, tasks: 0, attachments: 0, objects: 0, objectFailures: 0, notifications: 0, other: 0, skippedWithCalendarLinks: 0, more: false });

/** Deletes in bounded chunks so one statement never locks millions of rows; returns the number removed (capped by `max`). */
async function chunked(tx: Tx, run: (limit: number) => Promise<number>, max = 20_000): Promise<number> {
  let total = 0;
  while (total < max) {
    const n = await run(5000);
    total += n;
    if (n < 5000) break;
  }
  return total;
}

/** Cross-organization housekeeping: audit logs, finished jobs/outbox events, expired authentication artefacts. */
export async function purgeGlobal(db: Parameters<typeof withWorker>[0], now: Date, report: PurgeReport) {
  await withWorker(db, async (tx) => {
    // The 90-day floor lives inside the database function; the argument here can never lower it.
    const audit = await run<{ n: string }>(tx, sql`select purge_audit_logs(${RETENTION.auditLogDays}) as n`);
    report.auditLogs = Number(audit.rows[0]?.n ?? 0);

    const finished = cutoffDays(now, RETENTION.finishedJobDays);
    const dead = cutoffDays(now, RETENTION.deadJobDays);
    report.jobs = await chunked(tx, async (limit) => {
      const r = await run(tx, sql`
        with d as (select id from jobs where (status = 'succeeded' and finished_at < ${finished.toISOString()}::timestamptz) or (status = 'dead' and finished_at < ${dead.toISOString()}::timestamptz) limit ${limit} for update skip locked)
        delete from jobs using d where jobs.id = d.id`);
      return r.rowCount;
    });
    const processed = cutoffDays(now, RETENTION.processedOutboxDays);
    report.outbox = await chunked(tx, async (limit) => {
      const r = await run(tx, sql`
        with d as (select id from outbox_events where processed_at is not null and processed_at < ${processed.toISOString()}::timestamptz limit ${limit} for update skip locked)
        delete from outbox_events using d where outbox_events.id = d.id`);
      return r.rowCount;
    });

    const authCutoff = cutoffDays(now, RETENTION.expiredAuthGraceDays);
    const states = await tx.delete(oauthStates).where(lt(oauthStates.expiresAt, authCutoff)).returning({ k: oauthStates.stateHash });
    const sessions = await tx.delete(authSessions).where(lt(authSessions.expiresAt, authCutoff)).returning({ k: authSessions.id });
    const verifications = await tx.delete(authVerifications).where(lt(authVerifications.expiresAt, authCutoff)).returning({ k: authVerifications.id });
    const rl1 = await tx.delete(authRateLimits).where(lt(authRateLimits.lastRequest, authCutoff.getTime())).returning({ k: authRateLimits.id });
    const rl2 = await tx.delete(appRateLimits).where(lt(appRateLimits.windowStart, authCutoff)).returning({ k: appRateLimits.key });
    report.authRows = states.length + sessions.length + verifications.length + rl1.length + rl2.length;
  });
}

/** Permanently removes trashed tasks, removed attachments and aged operational rows of ONE organization. */
export async function purgeOrganization(ctx: Parameters<JobHandler>[0], orgId: string, now: Date, report: PurgeReport, deadline: number) {
  const trash = cutoffDays(now, RETENTION.trashDays);
  const keysToDelete: string[] = [];
  const counts = { tasks: 0, attachments: 0, notifications: 0, other: 0 };

  // Tasks are removed leaf-first in waves: a task with any child row (live or trashed) waits for the children.
  for (let wave = 0; wave < 20 && Date.now() < deadline; wave++) {
    const removed = await withWorkerOrg(ctx.db, orgId, async (tx) => {
      const leaves = await run<{ id: string }>(tx, sql`
        select t.id from tasks t
        where t.org_id = ${orgId} and t.deleted_at < ${trash.toISOString()}::timestamptz
          and not exists (select 1 from tasks c where c.org_id = t.org_id and c.parent_id = t.id)
          and not exists (select 1 from calendar_event_links l where l.org_id = t.org_id and l.task_id = t.id)
        order by t.deleted_at limit ${PURGE_BATCH}
        for update of t skip locked`);
      const ids = leaves.rows.map((r) => r.id);
      if (ids.length === 0) return 0;
      const files = await tx.select({ key: attachments.storageKey }).from(attachments).where(and(eq(attachments.orgId, orgId), inArray(attachments.taskId, ids)));
      const commentIds = (await tx.select({ id: comments.id }).from(comments).where(and(eq(comments.orgId, orgId), inArray(comments.taskId, ids)))).map((c) => c.id);
      if (commentIds.length) await tx.delete(commentMentions).where(and(eq(commentMentions.orgId, orgId), inArray(commentMentions.commentId, commentIds)));
      await tx.delete(comments).where(and(eq(comments.orgId, orgId), inArray(comments.taskId, ids)));
      await tx.delete(taskLabels).where(and(eq(taskLabels.orgId, orgId), inArray(taskLabels.taskId, ids)));
      await tx.delete(taskAssignees).where(and(eq(taskAssignees.orgId, orgId), inArray(taskAssignees.taskId, ids)));
      await tx.delete(taskDependencies).where(and(eq(taskDependencies.orgId, orgId), sql`(${inArray(taskDependencies.taskId, ids)} or ${inArray(taskDependencies.dependsOnId, ids)})`));
      await tx.delete(customFieldValues).where(and(eq(customFieldValues.orgId, orgId), inArray(customFieldValues.taskId, ids)));
      await tx.delete(attachments).where(and(eq(attachments.orgId, orgId), inArray(attachments.taskId, ids)));
      await tx.delete(taskActivity).where(and(eq(taskActivity.orgId, orgId), inArray(taskActivity.taskId, ids)));
      await tx.delete(notifications).where(and(eq(notifications.orgId, orgId), inArray(notifications.taskId, ids)));
      await tx.delete(tasks).where(and(eq(tasks.orgId, orgId), inArray(tasks.id, ids), isNotNull(tasks.deletedAt)));
      keysToDelete.push(...files.map((f) => f.key));
      counts.attachments += files.length;
      return ids.length;
    });
    counts.tasks += removed;
    if (removed === 0) break;
  }

  // Individually removed attachments whose grace period is over.
  const fileCutoff = cutoffDays(now, RETENTION.attachmentTrashDays);
  for (let i = 0; i < 20 && Date.now() < deadline; i++) {
    const n = await withWorkerOrg(ctx.db, orgId, async (tx) => {
      const old = await tx.select({ id: attachments.id, key: attachments.storageKey }).from(attachments).where(and(eq(attachments.orgId, orgId), lt(attachments.deletedAt, fileCutoff))).limit(PURGE_BATCH);
      if (old.length === 0) return 0;
      await tx.delete(attachments).where(and(eq(attachments.orgId, orgId), inArray(attachments.id, old.map((o) => o.id))));
      keysToDelete.push(...old.map((o) => o.key));
      counts.attachments += old.length;
      return old.length;
    });
    if (n < PURGE_BATCH) break;
  }

  await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const v = await tx.delete(savedViews).where(and(eq(savedViews.orgId, orgId), lt(savedViews.deletedAt, cutoffDays(now, RETENTION.viewTrashDays)))).returning({ id: savedViews.id });
    const nt = await tx.delete(notifications).where(and(eq(notifications.orgId, orgId), lt(notifications.createdAt, cutoffDays(now, RETENTION.notificationDays)))).returning({ id: notifications.id });
    const da = await tx.delete(deliveryAttempts).where(and(eq(deliveryAttempts.orgId, orgId), lt(deliveryAttempts.createdAt, cutoffDays(now, RETENTION.deliveryAttemptDays)))).returning({ id: deliveryAttempts.id });
    const dl = await tx.delete(digestLog).where(and(eq(digestLog.orgId, orgId), lt(digestLog.sentAt, cutoffDays(now, RETENTION.digestLogDays)))).returning({ k: digestLog.periodKey });
    counts.notifications += nt.length;
    counts.other += v.length + da.length + dl.length;
    const blocked = await run<{ n: string }>(tx, sql`
      select count(*)::text as n from tasks t where t.org_id = ${orgId} and t.deleted_at < ${trash.toISOString()}::timestamptz
        and exists (select 1 from calendar_event_links l where l.org_id = t.org_id and l.task_id = t.id)`);
    report.skippedWithCalendarLinks += Number(blocked.rows[0]?.n ?? 0);
    if (counts.tasks + counts.attachments + counts.notifications + counts.other > 0) {
      // Counts only: the audit trail records that data was removed under policy, never what it contained.
      await tx.insert(auditLogs).values({ orgId, actorUserId: null, action: "retention.purge", targetType: "organization", targetId: orgId, metadata: { ...counts } });
    }
  });

  // Files are removed AFTER the database commit: the database is the source of truth, and any object that could not
  // be deleted now is picked up by the orphan sweep (storage.orphans), so a failure here never loses or resurrects data.
  const settled = await Promise.allSettled(keysToDelete.map(async (k) => ctx.store.delete(k)));
  const failed = settled.filter((s) => s.status === "rejected");
  if (failed.length) logger.warn({ orgId, failed: failed.length, cls: errorClassOf((failed[0] as PromiseRejectedResult).reason) }, "retention: some storage objects were not deleted; the orphan sweep will retry");
  report.tasks += counts.tasks;
  report.attachments += counts.attachments;
  report.notifications += counts.notifications;
  report.other += counts.other;
  report.objects += settled.length - failed.length;
  report.objectFailures += failed.length;
}

export const retentionPurge: JobHandler = async (ctx) => {
  const now = ctx.now();
  const deadline = Date.now() + BUDGET_MS;
  const report = emptyReport();
  await purgeGlobal(ctx.db, now, report);
  const orgs = await withWorker(ctx.db, (tx) => tx.select({ id: organizations.id }).from(organizations));
  for (const org of orgs) {
    if (Date.now() >= deadline) { report.more = true; break; }
    try {
      await purgeOrganization(ctx, org.id, now, report, deadline);
    } catch (e) {
      // One organization's failure must not stop the others; the next run retries it.
      logger.error({ orgId: org.id, err: errorClassOf(e) }, "retention: organization purge failed");
    }
  }
  logger.info({ ...report }, "retention purge finished");
  if (report.more) throw new Deferred(new Date(Date.now() + 60_000), "retention has more work");
};

/**
 * Removes objects that have no database row (an upload whose transaction rolled back, or a delete whose file removal
 * failed). Objects younger than the grace period are left alone because their transaction may still be committing.
 */
export const storageOrphans: JobHandler = async (ctx) => {
  const now = ctx.now();
  const grace = cutoffHours(now, RETENTION.orphanGraceHours);
  const orgs = await withWorker(ctx.db, (tx) => tx.select({ id: organizations.id }).from(organizations));
  let removed = 0;
  for (const org of orgs) {
    let objects: { key: string; uploadedAt: Date }[];
    try { objects = await ctx.store.list(`orgs/${org.id}/`); } catch (e) { logger.warn({ orgId: org.id, err: errorClassOf(e) }, "storage orphan sweep: list failed"); continue; }
    const old = objects.filter((o) => o.uploadedAt < grace);
    for (let i = 0; i < old.length; i += 500) {
      const chunk = old.slice(i, i + 500);
      const known = await withWorkerOrg(ctx.db, org.id, (tx) => tx.select({ key: attachments.storageKey }).from(attachments).where(and(eq(attachments.orgId, org.id), inArray(attachments.storageKey, chunk.map((c) => c.key)))));
      const keep = new Set(known.map((k) => k.key));
      for (const o of chunk) {
        if (keep.has(o.key)) continue;
        try { await ctx.store.delete(o.key); removed++; } catch (e) { logger.warn({ orgId: org.id, err: errorClassOf(e) }, "storage orphan sweep: delete failed"); }
      }
    }
  }
  logger.info({ removed }, "storage orphan sweep finished");
};
