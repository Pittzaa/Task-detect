import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  calendarConnections, commentMentions, integrationDestinations, outboxEvents, projectTeams, taskAssignees, taskDependencies, tasks,
} from "@/db/schema";
import type { NotificationType } from "@/domain/notifications";
import { logger } from "@/lib/logger";
import { withWorker, switchOrg } from "../context";
import { deliverToUsers, orgAutoEmail } from "../notify";
import { enqueue } from "../queue";
import type { JobHandler } from "../worker";

type EventRow = typeof outboxEvents.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

const MAX_EVENT_ATTEMPTS = 5;
const CALENDAR_EVENTS = new Set(["task.created", "task.assigned", "task.updated", "task.due_changed", "task.status_changed", "task.deleted", "task.restored"]);
const DISCORD_MAP: Record<string, string> = {
  "task.created": "task.created", "task.assigned": "task.assigned", "task.commented": "task.commented",
  "task.status_changed": "task.status_changed", "task.priority_changed": "task.priority_changed",
};

const uniq = <T>(xs: (T | null | undefined)[]): T[] => [...new Set(xs.filter((x): x is T => x != null))];

/**
 * Turns committed domain events into notifications and downstream jobs. Safe to run repeatedly: notifications
 * are unique per (recipient, dedupe key), jobs are unique per dedupe key, and an event is marked processed in
 * the same transaction that creates its effects.
 */
export const outboxProcess: JobHandler = async (ctx) => {
  for (let round = 0; round < 20; round++) {
    const n = await withWorker(ctx.db, async (tx) => {
      const events = await tx.select().from(outboxEvents).where(isNull(outboxEvents.processedAt)).orderBy(asc(outboxEvents.createdAt)).limit(50).for("update", { skipLocked: true });
      for (const ev of events) {
        try {
          await tx.transaction(async (sp) => processEvent(sp as Tx, ev, ctx.now()));
          await tx.update(outboxEvents).set({ processedAt: ctx.now() }).where(eq(outboxEvents.id, ev.id));
        } catch (e) {
          const attempts = ev.attempts + 1;
          // A poison event is retired after a few tries so it cannot block the queue behind it.
          await tx.update(outboxEvents).set({ attempts, ...(attempts >= MAX_EVENT_ATTEMPTS ? { processedAt: ctx.now() } : {}) }).where(eq(outboxEvents.id, ev.id));
          logger.error({ eventId: ev.id, type: ev.type, attempts, err: e instanceof Error ? e.constructor.name : "unknown" }, "outbox event failed");
        }
      }
      return events.length;
    });
    if (n < 50) break;
  }
};

async function coAssignees(tx: Tx, orgId: string, taskId: string): Promise<string[]> {
  return (await tx.select({ u: taskAssignees.userId }).from(taskAssignees).where(and(eq(taskAssignees.orgId, orgId), eq(taskAssignees.taskId, taskId)))).map((r) => r.u);
}

async function participantsOf(tx: Tx, orgId: string, task: TaskRow): Promise<string[]> {
  return uniq([task.primaryAssigneeId, ...(await coAssignees(tx, orgId, task.id)), task.createdBy]);
}

async function processEvent(tx: Tx, ev: EventRow, now: Date) {
  await switchOrg(tx, ev.orgId);
  const autoEmail = await orgAutoEmail(tx, ev.orgId);
  const p = ev.payload as Record<string, unknown>;
  const taskId = typeof p.taskId === "string" ? p.taskId : null;
  if (!taskId) return;
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.orgId, ev.orgId), eq(tasks.id, taskId)));
  if (!task) return;
  const actorId = typeof p.actorId === "string" ? p.actorId : null;

  const notify = (target: TaskRow, type: NotificationType, userIds: string[], params: Record<string, string>, key: string) =>
    deliverToUsers(tx, { orgId: ev.orgId, task: target, type, userIds, actorId, params, key, now, autoEmail });

  const added = Array.isArray(p.added) ? (p.added as string[]) : [];
  const removed = Array.isArray(p.removed) ? (p.removed as string[]) : [];

  switch (ev.type) {
    case "task.assigned":
      await notify(task, "task.assigned", added, {}, `${ev.id}:assigned`);
      await notify(task, "task.unassigned", removed, {}, `${ev.id}:unassigned`);
      break;
    case "task.commented": {
      const mentioned = typeof p.commentId === "string" ? (await tx.select({ u: commentMentions.userId }).from(commentMentions).where(and(eq(commentMentions.orgId, ev.orgId), eq(commentMentions.commentId, p.commentId)))).map((r) => r.u) : [];
      // People @mentioned get the more specific mention notification instead.
      await notify(task, "task.commented", (await participantsOf(tx, ev.orgId, task)).filter((u) => !mentioned.includes(u)), {}, `${ev.id}:comment`);
      break;
    }
    case "task.mentioned":
      await notify(task, "task.mentioned", Array.isArray(p.userIds) ? (p.userIds as string[]) : [], {}, `${ev.id}:mention`);
      break;
    case "task.status_changed": {
      const to = String(p.to ?? "");
      await notify(task, "task.status_changed", await participantsOf(tx, ev.orgId, task), { status: to }, `${ev.id}:status`);
      if (to === "done" || to === "cancelled" || p.from === "done") {
        const dependents = await tx
          .select({ t: tasks })
          .from(taskDependencies)
          .innerJoin(tasks, and(eq(tasks.orgId, taskDependencies.orgId), eq(tasks.id, taskDependencies.taskId)))
          .where(and(eq(taskDependencies.orgId, ev.orgId), eq(taskDependencies.dependsOnId, task.id), isNull(tasks.deletedAt)));
        for (const { t: dep } of dependents) {
          await notify(dep, "task.dependency_changed", uniq([dep.primaryAssigneeId, ...(await coAssignees(tx, ev.orgId, dep.id))]), { status: to }, `${ev.id}:dep:${dep.id}`);
        }
      }
      break;
    }
    case "task.priority_changed":
      await notify(task, "task.priority_changed", await participantsOf(tx, ev.orgId, task), { priority: String(p.to ?? "") }, `${ev.id}:priority`);
      break;
    default:
      break;
  }

  // Discord: destinations bound to this task's project or to one of its teams.
  const discordEvent = DISCORD_MAP[ev.type];
  if (discordEvent && !task.deletedAt && !(ev.type === "task.assigned" && added.length === 0)) {
    const teamIds = (await tx.select({ t: projectTeams.teamId }).from(projectTeams).where(and(eq(projectTeams.orgId, ev.orgId), eq(projectTeams.projectId, task.projectId)))).map((r) => r.t);
    const dests = await tx
      .select({ id: integrationDestinations.id })
      .from(integrationDestinations)
      .where(and(eq(integrationDestinations.orgId, ev.orgId), eq(integrationDestinations.enabled, true), isNull(integrationDestinations.deletedAt), sql`${integrationDestinations.events} @> ARRAY[${discordEvent}]::text[]`,
        teamIds.length ? sql`(${integrationDestinations.projectId} = ${task.projectId} or ${integrationDestinations.teamId} in (${sql.join(teamIds.map((t) => sql`${t}`), sql`, `)}))` : eq(integrationDestinations.projectId, task.projectId)));
    for (const d of dests) await enqueue(tx, { kind: "discord.send", orgId: ev.orgId, payload: { destinationId: d.id, taskId: task.id, event: discordEvent }, dedupeKey: `discord:${ev.id}:${d.id}`, maxAttempts: 6, runAt: now });
  }

  // Google Calendar: re-sync the task for everyone it concerns. The job recomputes the desired state from the database.
  if (CALENDAR_EVENTS.has(ev.type)) {
    const users = uniq([task.primaryAssigneeId, ...(await coAssignees(tx, ev.orgId, task.id)), ...removed, ...added]);
    if (users.length) {
      const conns = await tx.select({ id: calendarConnections.id }).from(calendarConnections).where(and(eq(calendarConnections.orgId, ev.orgId), inArray(calendarConnections.userId, users), eq(calendarConnections.status, "active")));
      for (const c of conns) await enqueue(tx, { kind: "calendar.sync_task", orgId: ev.orgId, payload: { connectionId: c.id, taskId: task.id }, dedupeKey: `cal:${ev.id}:${c.id}`, maxAttempts: 6, runAt: now });
    }
  }
}
