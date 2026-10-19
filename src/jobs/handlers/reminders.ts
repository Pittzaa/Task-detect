import { and, eq, gte, isNotNull, isNull, lte, notInArray, sql } from "drizzle-orm";
import { integrationDestinations, organizations, projectTeams, taskAssignees, tasks } from "@/db/schema";
import { addDays, reminderInstant, todayIn } from "@/domain/time";
import { withWorker, withWorkerOrg } from "../context";
import { deliverToUsers, loadProfiles, orgAutoEmail } from "../notify";
import { enqueue } from "../queue";
import type { JobHandler } from "../worker";
import { logger } from "@/lib/logger";

const WINDOW_PAST_DAYS = 31; // tasks overdue longer than this no longer generate alerts
const WINDOW_AHEAD_DAYS = 32; // reminders can be set up to 30 days ahead
const PER_ORG_LIMIT = 1000;

/**
 * Finds due-soon and overdue tasks and notifies their assignees. It does not matter how often or how late this
 * runs: every notification has a deterministic dedupe key (task + due date [+ reminder offset] + recipient), so a
 * missed run is caught up on the next one and a repeated run creates nothing new. Changing a task's due date
 * naturally produces a fresh key, so the new date gets its own reminder.
 */
export const remindersScan: JobHandler = async (ctx) => {
  const orgs = await withWorker(ctx.db, (tx) => tx.select({ id: organizations.id }).from(organizations).where(isNull(organizations.deletedAt)));
  for (const org of orgs) {
    try {
      await scanOrg(ctx, org.id);
    } catch (e) {
      logger.error({ orgId: org.id, err: e instanceof Error ? e.constructor.name : "unknown" }, "reminder scan failed for organization");
    }
  }
};

async function scanOrg(ctx: Parameters<JobHandler>[0], orgId: string) {
  const now = ctx.now();
  const utcToday = now.toISOString().slice(0, 10);
  await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const autoEmail = await orgAutoEmail(tx, orgId);
    const rows = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), notInArray(tasks.status, ["done", "cancelled"]), isNotNull(tasks.dueDate), gte(tasks.dueDate, addDays(utcToday, -WINDOW_PAST_DAYS)), lte(tasks.dueDate, addDays(utcToday, WINDOW_AHEAD_DAYS))))
      .limit(PER_ORG_LIMIT);
    for (const task of rows) {
      const co = (await tx.select({ u: taskAssignees.userId }).from(taskAssignees).where(and(eq(taskAssignees.orgId, orgId), eq(taskAssignees.taskId, task.id)))).map((r) => r.u);
      const recipients = [...new Set([task.primaryAssigneeId, ...co].filter((x): x is string => !!x))];
      if (!recipients.length) continue;
      const profiles = await loadProfiles(tx, recipients);
      let overdueFired = false;
      let dueSoonFired = false;
      for (const userId of recipients) {
        const tz = profiles.get(userId)?.timezone ?? "Asia/Bangkok";
        const today = todayIn(tz, now);
        const due = task.dueDate!;
        if (due < today) {
          const n = await deliverToUsers(tx, { orgId, task, type: "task.overdue", userIds: [userId], params: { dueDate: due }, key: `overdue:${task.id}:${due}`, now, autoEmail });
          overdueFired ||= n > 0;
        } else if (task.reminderDaysBefore != null && now >= reminderInstant(due, task.reminderDaysBefore, tz)) {
          const n = await deliverToUsers(tx, { orgId, task, type: "task.due_soon", userIds: [userId], params: { dueDate: due }, key: `due:${task.id}:${due}:${task.reminderDaysBefore}`, now, autoEmail });
          dueSoonFired ||= n > 0;
        }
      }
      for (const [fired, event, key] of [[overdueFired, "task.overdue", `overdue:${task.id}:${task.dueDate}`], [dueSoonFired, "task.due_soon", `due:${task.id}:${task.dueDate}:${task.reminderDaysBefore}`]] as const) {
        if (fired) await fanOutDiscord(tx, orgId, task, event, key, now);
      }
    }
  });
}

async function fanOutDiscord(tx: Parameters<Parameters<typeof withWorkerOrg>[2]>[0], orgId: string, task: typeof tasks.$inferSelect, event: string, key: string, now: Date) {
  const teamIds = (await tx.select({ t: projectTeams.teamId }).from(projectTeams).where(and(eq(projectTeams.orgId, orgId), eq(projectTeams.projectId, task.projectId)))).map((r) => r.t);
  const dests = await tx
    .select({ id: integrationDestinations.id })
    .from(integrationDestinations)
    .where(and(eq(integrationDestinations.orgId, orgId), eq(integrationDestinations.enabled, true), isNull(integrationDestinations.deletedAt), sql`${integrationDestinations.events} @> ARRAY[${event}]::text[]`,
      teamIds.length ? sql`(${integrationDestinations.projectId} = ${task.projectId} or ${integrationDestinations.teamId} in (${sql.join(teamIds.map((t) => sql`${t}`), sql`, `)}))` : eq(integrationDestinations.projectId, task.projectId)));
  for (const d of dests) await enqueue(tx, { kind: "discord.send", orgId, payload: { destinationId: d.id, taskId: task.id, event }, dedupeKey: `discord:${key}:${d.id}`, maxAttempts: 6, runAt: now });
}
