import { and, eq, isNull } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { auditLogs, tasks } from "@/db/schema";
import type { TaskPriority, TaskStatus } from "@/domain/workflow";
import { AppError, validation } from "@/lib/errors";
import { describeError } from "@/lib/error-report";
import { logger } from "@/lib/logger";
import { consumeRateLimit } from "@/server/rate-limit";
import { changeStatus, setPrimaryAssignee, updateTask } from "./tasks";
import type { TenantSession } from "./tenant";

export const MAX_BULK = 100;

export type BulkAction =
  | { type: "status"; status: TaskStatus }
  | { type: "priority"; priority: TaskPriority }
  | { type: "assignee"; userId: string | null }
  | { type: "dueDate"; dueDate: string | null };

export type BulkItemResult = { taskId: string; ok: true } | { taskId: string; ok: false; code: "NOT_FOUND" | "FORBIDDEN" | "VALIDATION" | "CONFLICT" | "ROLLED_BACK" | "ERROR" };

/**
 * Applies one action to many tasks, authorizing and validating EACH task independently.
 *
 * Policy (documented in docs/WORKFLOW.md):
 *  - default is partial success: every item runs in its own savepoint, so a failure never affects the others;
 *  - with `atomic: true` any failure rolls the whole operation back (HTTP 409 with the per-item results);
 *  - tasks the caller cannot read and tasks that do not exist both report NOT_FOUND, so results leak nothing.
 */
export async function bulkUpdate(s: TenantSession, input: { taskIds: string[]; action: BulkAction; atomic?: boolean }): Promise<{ results: BulkItemResult[]; succeeded: number; failed: number }> {
  const ids = [...new Set(input.taskIds)];
  if (!ids.length) throw validation("No tasks selected");
  if (ids.length > MAX_BULK) throw validation(`At most ${MAX_BULK} tasks per request`);
  await consumeRateLimit(s.tx as unknown as Db, `bulk:${s.userId}`, 600, 20);

  // Rows are locked as each item is processed and the locks last until the whole request commits. Two requests over the same
  // tasks in opposite orders would deadlock, so every request locks in one global order (ascending id) and the results are
  // put back in the caller's order afterwards.
  const byId = new Map<string, BulkItemResult>();
  for (const taskId of [...ids].sort()) {
    try {
      await (s.tx as Tx).transaction(async (sp) => {
        const sub: TenantSession = { ...s, tx: sp as Tx };
        await applyOne(sub, taskId, input.action);
      });
      byId.set(taskId, { taskId, ok: true });
    } catch (e) {
      if (e instanceof AppError && ["NOT_FOUND", "FORBIDDEN", "VALIDATION", "CONFLICT"].includes(e.code)) {
        byId.set(taskId, { taskId, ok: false, code: e.code as "NOT_FOUND" | "FORBIDDEN" | "VALIDATION" | "CONFLICT" });
      } else {
        logger.error({ error: describeError(e) }, "bulk item failed");
        byId.set(taskId, { taskId, ok: false, code: "ERROR" });
      }
    }
  }
  const results: BulkItemResult[] = ids.map((id) => byId.get(id)!);
  const failed = results.filter((r) => !r.ok).length;
  if (input.atomic && failed > 0) {
    const rolledBack: BulkItemResult[] = results.map((r) => (r.ok ? { taskId: r.taskId, ok: false, code: "ROLLED_BACK" } : r));
    throw new AppError("CONFLICT", "Bulk operation rolled back", 409, undefined, { results: rolledBack });
  }
  await s.tx.insert(auditLogs).values({
    orgId: s.orgId, actorUserId: s.userId, action: "task.bulk_update",
    metadata: { action: input.action.type, requested: ids.length, succeeded: ids.length - failed, failed },
  });
  return { results, succeeded: ids.length - failed, failed };
}

async function applyOne(s: TenantSession, taskId: string, action: BulkAction) {
  if (action.type === "status") {
    await changeStatus(s, taskId, action.status);
  } else if (action.type === "assignee") {
    await setPrimaryAssignee(s, taskId, action.userId);
  } else {
    // Locked, so the version read here is the current one (a bulk change is not a stale form submission).
    const [row] = await s.tx.select({ version: tasks.version }).from(tasks).where(and(eq(tasks.orgId, s.orgId), eq(tasks.id, taskId), isNull(tasks.deletedAt))).for("update");
    if (!row) throw new AppError("NOT_FOUND", "Not found", 404);
    // updateTask re-checks read access and task.update before changing anything.
    await updateTask(s, taskId, action.type === "priority" ? { version: row.version, priority: action.priority } : { version: row.version, dueDate: action.dueDate });
  }
}
