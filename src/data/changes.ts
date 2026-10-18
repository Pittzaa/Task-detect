import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { comments, notifications, tasks } from "@/db/schema";
import { accessibleProjectIds } from "./scope";
import { loadTask } from "./tasks";
import type { TenantSession } from "./tenant";

export interface ChangeSignal {
  /** Changes whenever a task the caller may read is created, edited, moved, assigned, labelled, (un)deleted or restored. */
  tasks: string;
  /** The caller's own notifications (new, read). */
  notifications: string;
  /** Comments on one task (only when a task is asked for and the caller may read it). */
  comments?: string;
}

const token = (...parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
const stamp = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : 0);

/**
 * A cheap fingerprint of what the caller can currently see, for "has anything changed?" polling. The page fetches the real data only
 * when a fingerprint differs from the last one, so changes show up within seconds without every open page re-running its heavy queries
 * on a timer. It is permission-aware: tasks are counted only in projects the caller may read, notifications are the caller's own, and
 * comments need the same task access as reading them. A fingerprint is a hash, so it reveals neither counts nor times — only "same" or
 * "different" — and it can only differ because something the caller is entitled to see changed.
 */
export async function changeSignal(s: TenantSession, o: { taskId?: string } = {}): Promise<ChangeSignal> {
  const readable = await accessibleProjectIds(s, "task.read");
  let taskPart: unknown[] = [0, 0, 0];
  if (readable === "all" || readable.length) {
    const [row] = await s.tx
      .select({ n: sql<number>`count(*)::int`, updated: sql<Date | null>`max(${tasks.updatedAt})`, deleted: sql<Date | null>`max(${tasks.deletedAt})`, open: sql<number>`count(*) filter (where ${tasks.deletedAt} is null)::int` })
      .from(tasks)
      .where(and(eq(tasks.orgId, s.orgId), readable === "all" ? undefined : inArray(tasks.projectId, readable)));
    taskPart = [row?.n ?? 0, row?.open ?? 0, stamp(row?.updated), stamp(row?.deleted)];
  }

  const [nrow] = await s.tx
    .select({ n: sql<number>`count(*)::int`, unread: sql<number>`count(*) filter (where ${notifications.readAt} is null)::int`, created: sql<Date | null>`max(${notifications.createdAt})`, read: sql<Date | null>`max(${notifications.readAt})` })
    .from(notifications)
    .where(and(eq(notifications.orgId, s.orgId), eq(notifications.userId, s.userId)));

  const out: ChangeSignal = { tasks: token("t", taskPart), notifications: token("n", nrow?.n ?? 0, nrow?.unread ?? 0, stamp(nrow?.created), stamp(nrow?.read)) };

  if (o.taskId) {
    const { task } = await loadTask(s, o.taskId); // NOT_FOUND unless the caller can read it
    const [crow] = await s.tx
      .select({ n: sql<number>`count(*)::int`, created: sql<Date | null>`max(${comments.createdAt})`, edited: sql<Date | null>`max(${comments.editedAt})`, deleted: sql<Date | null>`max(${comments.deletedAt})` })
      .from(comments)
      .where(and(eq(comments.orgId, s.orgId), eq(comments.taskId, task.id)));
    out.comments = token("c", crow?.n ?? 0, stamp(crow?.created), stamp(crow?.edited), stamp(crow?.deleted));
  }
  return out;
}
