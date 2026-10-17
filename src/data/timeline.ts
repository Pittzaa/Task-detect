import { and, eq, inArray } from "drizzle-orm";
import { taskDependencies } from "@/db/schema";
import { listTasks, type TaskFilter, type TaskSummary } from "./tasks";
import type { TenantSession } from "./tenant";

/**
 * Data for the Gantt/timeline and calendar views. Tasks come from the same `listTasks` path as every
 * other view (so permissions and soft deletion are identical). Dependency edges are returned only
 * when BOTH ends are in the returned set, so an edge can never reveal a task the caller cannot read.
 *
 * Limitations (documented in docs/WORKFLOW.md): tasks with neither start nor due date are not shown;
 * a task with only one date is drawn as a single-day bar; nesting is shown by indentation using
 * `parentId`, and subtasks whose parent is outside the window appear at the top level.
 */
export async function getTimeline(s: TenantSession, f: Pick<TaskFilter, "projectId" | "rangeFrom" | "rangeTo" | "status" | "assignee" | "limit">) {
  const { items, hasMore } = await listTasks(s, { ...f, sort: "due", limit: f.limit ?? 100 });
  const ids = items.map((t) => t.id);
  const edges = ids.length
    ? await s.tx
        .select({ taskId: taskDependencies.taskId, prerequisiteId: taskDependencies.dependsOnId })
        .from(taskDependencies)
        .where(and(eq(taskDependencies.orgId, s.orgId), inArray(taskDependencies.taskId, ids), inArray(taskDependencies.dependsOnId, ids)))
    : [];
  return { items, hasMore, edges };
}

export type { TaskSummary };
