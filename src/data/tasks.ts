import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, ne, notInArray, or, sql, type SQL } from "drizzle-orm";
import { can, type ResourceScope } from "@/authz/evaluate";
import type { Permission } from "@/authz/permissions";
import type { Tx } from "@/db/client";
import {
  auditLogs, commentMentions, comments, labels, outboxEvents, taskActivity, taskAssignees, taskDependencies, taskLabels, tasks, users,
} from "@/db/schema";
import { MAX_SUBTASK_DEPTH } from "@/domain/graph";
import {
  canCompleteParent, completedAtFor, dependencyGate, isTerminal, transitionKind, validateDateRange,
  type TaskPriority, type TaskStatus,
} from "@/domain/workflow";
import { conflict, forbidden, notFound, validation } from "@/lib/errors";
import { customFilterConditions, defaultsFor, valuesForTasks, writeCustomValues, type CustomFilter } from "./custom-fields";
import { escapeLikeValue } from "./like";
import { accessibleProjectIds, projectScope, projectScopes } from "./scope";
import { loadPrincipal, type TenantSession } from "./tenant";

export type TaskRow = typeof tasks.$inferSelect;

const MAX_COASSIGNEES = 20;
const MAX_LABELS = 20;
const MAX_MENTIONS = 20;

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

async function emit(s: TenantSession, type: string, payload: Record<string, unknown>) {
  await s.tx.insert(outboxEvents).values({ orgId: s.orgId, type, payload });
}

async function activity(s: TenantSession, taskId: string, type: string, changes: Record<string, unknown> = {}) {
  await s.tx.insert(taskActivity).values({ orgId: s.orgId, taskId, actorId: s.userId, type, changes });
}

async function audit(s: TenantSession, action: string, taskId: string, metadata: Record<string, unknown> = {}) {
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action, targetType: "task", targetId: taskId, metadata });
}

function need(s: TenantSession, permission: Permission, scope: ResourceScope) {
  if (!can(s.principal, permission, scope)) throw forbidden({ permission });
}

/**
 * Loads a live task and its authorization scope. A task the principal cannot read is reported as
 * NOT_FOUND (never FORBIDDEN) so the existence of other teams' tasks is not revealed.
 */
export async function loadTask(s: TenantSession, taskId: string, opts: { forUpdate?: boolean; includeDeleted?: boolean } = {}) {
  const base = and(eq(tasks.orgId, s.orgId), eq(tasks.id, taskId), opts.includeDeleted ? undefined : isNull(tasks.deletedAt));
  const q = s.tx.select().from(tasks).where(base);
  const [task] = opts.forUpdate ? await q.for("update") : await q;
  if (!task) throw notFound();
  const scope = await projectScope(s, task.projectId);
  if (!scope || !can(s.principal, "task.read", scope)) throw notFound();
  return { task, scope };
}

async function assertAssignable(s: TenantSession, userId: string, scope: ResourceScope) {
  const fail = () => validation("Assignee cannot be assigned to this task");
  const principal = userId === s.userId ? s.principal : await loadPrincipal(s.tx, userId, s.orgId);
  if (!principal || !can(principal, "task.read", scope)) throw fail();
}

async function ancestorDepth(tx: Tx, orgId: string, taskId: string): Promise<number> {
  const res = (await tx.execute(sql`
    with recursive up(id, depth) as (
      select parent_id, 1 from tasks where org_id = ${orgId} and id = ${taskId} and parent_id is not null
      union all
      select t.parent_id, up.depth + 1 from tasks t join up on t.id = up.id and t.org_id = ${orgId} where t.parent_id is not null
    ) select coalesce(max(depth), 0)::int as d from up`)) as unknown as { rows: { d: number }[] };
  return res.rows[0]?.d ?? 0;
}

async function descendantIds(tx: Tx, orgId: string, rootId: string, opts: { deleted?: boolean } = {}): Promise<string[]> {
  const cond = opts.deleted ? sql`t.deleted_at is not null` : sql`t.deleted_at is null`;
  const res = (await tx.execute(sql`
    with recursive down(id) as (
      select id from tasks where org_id = ${orgId} and parent_id = ${rootId}
      union all
      select t.id from tasks t join down on t.parent_id = down.id and t.org_id = ${orgId}
    ) select t.id from tasks t join down on t.id = down.id where t.org_id = ${orgId} and ${cond}`)) as unknown as { rows: { id: string }[] };
  return res.rows.map((r) => r.id);
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// ---------------------------------------------------------------------------------------------
// create / read / update
// ---------------------------------------------------------------------------------------------

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  startDate?: string | null;
  dueDate?: string | null;
  reminderDaysBefore?: number | null;
  parentId?: string | null;
  primaryAssigneeId?: string | null;
  coAssigneeIds?: string[];
  labelIds?: string[];
  /** fieldId -> value; fields not supplied receive their configured default */
  customFields?: Record<string, unknown>;
}

export async function createTask(s: TenantSession, input: CreateTaskInput) {
  const scope = await projectScope(s, input.projectId);
  if (!scope || !can(s.principal, "task.read", scope)) throw notFound();
  need(s, "task.create", scope);

  const title = input.title.trim();
  if (!title || title.length > 300) throw validation("val.title_required");
  if (!validateDateRange(input.startDate, input.dueDate)) throw validation("val.date_range");

  if (input.parentId) {
    const [parent] = await s.tx.select({ id: tasks.id, projectId: tasks.projectId }).from(tasks).where(and(eq(tasks.orgId, s.orgId), eq(tasks.id, input.parentId), isNull(tasks.deletedAt)));
    if (!parent || parent.projectId !== input.projectId) throw validation("Invalid parent task");
    if ((await ancestorDepth(s.tx, s.orgId, parent.id)) + 1 >= MAX_SUBTASK_DEPTH) throw validation("Subtasks are limited to " + MAX_SUBTASK_DEPTH + " levels");
  }

  const co = [...new Set(input.coAssigneeIds ?? [])].filter((u) => u !== input.primaryAssigneeId);
  if (co.length > MAX_COASSIGNEES) throw validation("Too many co-assignees");
  const everyone = [...(input.primaryAssigneeId ? [input.primaryAssigneeId] : []), ...co];
  if (everyone.length) {
    // Assigning only yourself needs task.update; assigning others needs task.assign.
    if (everyone.every((u) => u === s.userId)) need(s, "task.create", scope);
    else need(s, "task.assign", scope);
    for (const u of everyone) await assertAssignable(s, u, scope);
  }

  const labelIds = [...new Set(input.labelIds ?? [])];
  if (labelIds.length > MAX_LABELS) throw validation("Too many labels");
  await assertLabelsExist(s, labelIds);

  const [row] = await s.tx
    .insert(tasks)
    .values({
      orgId: s.orgId, projectId: input.projectId, parentId: input.parentId ?? null, title, description: input.description ?? "",
      priority: input.priority ?? "medium", startDate: input.startDate ?? null, dueDate: input.dueDate ?? null,
      reminderDaysBefore: input.reminderDaysBefore ?? null, primaryAssigneeId: input.primaryAssigneeId ?? null,
      createdBy: s.userId, updatedBy: s.userId,
    })
    .returning();
  if (co.length) await s.tx.insert(taskAssignees).values(co.map((userId) => ({ orgId: s.orgId, taskId: row!.id, userId })));
  if (labelIds.length) await s.tx.insert(taskLabels).values(labelIds.map((labelId) => ({ orgId: s.orgId, taskId: row!.id, labelId })));
  await writeCustomValues(s.tx, s.orgId, row!.id, { ...(await defaultsFor(s.tx, s.orgId)), ...(input.customFields ?? {}) });
  await activity(s, row!.id, "created");
  await audit(s, "task.create", row!.id);
  await emit(s, "task.created", { taskId: row!.id, actorId: s.userId });
  if (everyone.length) await emit(s, "task.assigned", { taskId: row!.id, actorId: s.userId, added: everyone.filter((u) => u !== s.userId), removed: [] });
  return row!;
}

async function assertLabelsExist(s: TenantSession, labelIds: string[]) {
  if (!labelIds.length) return;
  const found = await s.tx.select({ id: labels.id }).from(labels).where(and(eq(labels.orgId, s.orgId), inArray(labels.id, labelIds)));
  if (found.length !== labelIds.length) throw validation("Unknown label");
}

export interface UpdateTaskInput {
  version: number;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  startDate?: string | null;
  dueDate?: string | null;
  reminderDaysBefore?: number | null;
}

export async function updateTask(s: TenantSession, taskId: string, input: UpdateTaskInput) {
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  need(s, "task.update", scope);
  if (task.version !== input.version) throw conflict("The task was changed by someone else. Reload and try again.");

  const patch: Partial<typeof tasks.$inferInsert> = {};
  const changes: Record<string, unknown> = {};
  const set = <K extends "title" | "description" | "priority" | "startDate" | "dueDate" | "reminderDaysBefore">(k: K, v: (typeof tasks.$inferInsert)[K]) => {
    if (v !== undefined && v !== task[k]) {
      patch[k] = v;
      // Never record text bodies; only that they changed.
      changes[k] = k === "title" || k === "description" ? "changed" : { from: task[k], to: v };
    }
  };
  if (input.title !== undefined) {
    const title = input.title.trim();
    if (!title || title.length > 300) throw validation("val.title_required");
    set("title", title);
  }
  set("description", input.description);
  set("priority", input.priority);
  set("startDate", input.startDate);
  set("dueDate", input.dueDate);
  set("reminderDaysBefore", input.reminderDaysBefore);
  const start = "startDate" in patch ? patch.startDate : task.startDate;
  const due = "dueDate" in patch ? patch.dueDate : task.dueDate;
  if (!validateDateRange(start, due)) throw validation("val.date_range");
  if (!Object.keys(patch).length) return task;

  const [row] = await s.tx
    .update(tasks)
    .set({ ...patch, version: task.version + 1, updatedAt: new Date(), updatedBy: s.userId })
    .where(and(eq(tasks.orgId, s.orgId), eq(tasks.id, task.id), eq(tasks.version, task.version)))
    .returning();
  if (!row) throw conflict("The task was changed by someone else. Reload and try again.");
  await activity(s, task.id, "updated", changes);
  await audit(s, "task.update", task.id, { fields: Object.keys(changes) });
  await emit(s, "task.updated", { taskId: task.id, actorId: s.userId, fields: Object.keys(changes) });
  if (changes.priority) await emit(s, "task.priority_changed", { taskId: task.id, actorId: s.userId, to: patch.priority });
  if (changes.dueDate !== undefined) await emit(s, "task.due_changed", { taskId: task.id, actorId: s.userId });
  return row;
}

// ---------------------------------------------------------------------------------------------
// status workflow
// ---------------------------------------------------------------------------------------------

export async function changeStatus(s: TenantSession, taskId: string, to: TaskStatus) {
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  need(s, "task.change_status", scope);
  const kind = transitionKind(task.status, to);
  if (kind === "none") return task;
  if (kind === "invalid") throw validation("val.status_transition", { from: task.status, to });
  if (kind === "reopen") need(s, "task.reopen", scope);

  const prereqs = await s.tx
    .select({ id: tasks.id, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, and(eq(tasks.orgId, taskDependencies.orgId), eq(tasks.id, taskDependencies.dependsOnId)))
    .where(and(eq(taskDependencies.orgId, s.orgId), eq(taskDependencies.taskId, task.id), isNull(tasks.deletedAt)));
  const gate = dependencyGate(to, prereqs);
  if (!gate.allowed) throw validation("val.dependency_blocked", { blockedByCount: gate.blockedBy.length });

  if (to === "done") {
    const kids = await s.tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.orgId, s.orgId), eq(tasks.parentId, task.id), isNull(tasks.deletedAt)));
    if (!canCompleteParent(kids)) throw validation("val.parent_incomplete");
  }

  const now = new Date();
  const [row] = await s.tx
    .update(tasks)
    .set({ status: to, completedAt: completedAtFor(to, task.completedAt, now), version: task.version + 1, updatedAt: now, updatedBy: s.userId })
    .where(and(eq(tasks.orgId, s.orgId), eq(tasks.id, task.id)))
    .returning();
  await activity(s, task.id, kind === "reopen" ? "reopened" : "status_changed", { status: { from: task.status, to } });
  await audit(s, "task.status_change", task.id, { from: task.status, to });
  await emit(s, "task.status_changed", { taskId: task.id, actorId: s.userId, from: task.status, to });
  return row!;
}

// ---------------------------------------------------------------------------------------------
// assignees
// ---------------------------------------------------------------------------------------------

export async function setAssignees(s: TenantSession, taskId: string, input: { primary: string | null; co: string[] }) {
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  const co = [...new Set(input.co)].filter((u) => u !== input.primary);
  if (co.length > MAX_COASSIGNEES) throw validation("Too many co-assignees");
  const currentCo = (await s.tx.select({ userId: taskAssignees.userId }).from(taskAssignees).where(and(eq(taskAssignees.orgId, s.orgId), eq(taskAssignees.taskId, task.id)))).map((r) => r.userId);
  const before = [...(task.primaryAssigneeId ? [task.primaryAssigneeId] : []), ...currentCo];
  const after = [...(input.primary ? [input.primary] : []), ...co];
  const added = after.filter((u) => !before.includes(u));
  const removed = before.filter((u) => !after.includes(u));
  if (!added.length && !removed.length && task.primaryAssigneeId === input.primary) return task;

  // Taking or leaving a task yourself needs task.update; changing anyone else needs task.assign.
  const onlySelf = [...added, ...removed].every((u) => u === s.userId);
  need(s, onlySelf ? "task.update" : "task.assign", scope);
  for (const u of added) await assertAssignable(s, u, scope);

  await s.tx.delete(taskAssignees).where(and(eq(taskAssignees.orgId, s.orgId), eq(taskAssignees.taskId, task.id)));
  if (co.length) await s.tx.insert(taskAssignees).values(co.map((userId) => ({ orgId: s.orgId, taskId: task.id, userId })));
  const [row] = await s.tx
    .update(tasks)
    .set({ primaryAssigneeId: input.primary, version: task.version + 1, updatedAt: new Date(), updatedBy: s.userId })
    .where(and(eq(tasks.orgId, s.orgId), eq(tasks.id, task.id)))
    .returning();
  await activity(s, task.id, "assignees_changed", { added, removed, primary: input.primary });
  await audit(s, "task.assign", task.id, { added: added.length, removed: removed.length });
  await emit(s, "task.assigned", { taskId: task.id, actorId: s.userId, added, removed });
  return row!;
}

// ---------------------------------------------------------------------------------------------
// dependencies
// ---------------------------------------------------------------------------------------------

/** Marks the task as changed (list views show its labels and dependency count, and change signals watch `updated_at`). */
async function touch(s: TenantSession, taskId: string) {
  await s.tx.update(tasks).set({ updatedAt: new Date(), updatedBy: s.userId }).where(and(eq(tasks.orgId, s.orgId), eq(tasks.id, taskId)));
}

export async function addDependency(s: TenantSession, taskId: string, prerequisiteId: string) {
  if (taskId === prerequisiteId) throw validation("val.dependency_cycle");
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  const { task: prereq } = await loadTask(s, prerequisiteId); // must be readable too
  need(s, "task.manage_dependencies", scope);

  // Serialise dependency edits per org so two concurrent additions cannot jointly form a cycle.
  await s.tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"task-deps:" + s.orgId}, 0))`);
  const cyc = (await s.tx.execute(sql`
    with recursive upstream(id) as (
      select ${prereq.id}::uuid
      union
      select d.depends_on_id from task_dependencies d join upstream u on d.task_id = u.id and d.org_id = ${s.orgId}
    ) select 1 as hit from upstream where id = ${task.id}::uuid limit 1`)) as unknown as { rows: unknown[] };
  if (cyc.rows.length) throw validation("val.dependency_cycle");

  if (["progress", "review", "done"].includes(task.status) && prereq.status !== "done") throw validation("val.dependency_blocked", { blockedByCount: 1 });

  const ins = await s.tx.insert(taskDependencies).values({ orgId: s.orgId, taskId: task.id, dependsOnId: prereq.id, createdBy: s.userId }).onConflictDoNothing().returning({ t: taskDependencies.taskId });
  if (!ins[0]) return; // already present
  await touch(s, task.id);
  await activity(s, task.id, "dependency_added", { prerequisite: prereq.id });
  await audit(s, "task.dependency_add", task.id, { prerequisite: prereq.id });
}

export async function removeDependency(s: TenantSession, taskId: string, prerequisiteId: string) {
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  need(s, "task.manage_dependencies", scope);
  const del = await s.tx.delete(taskDependencies).where(and(eq(taskDependencies.orgId, s.orgId), eq(taskDependencies.taskId, task.id), eq(taskDependencies.dependsOnId, prerequisiteId))).returning({ t: taskDependencies.taskId });
  if (!del[0]) throw notFound();
  await touch(s, task.id);
  await activity(s, task.id, "dependency_removed", { prerequisite: prerequisiteId });
  await audit(s, "task.dependency_remove", task.id, { prerequisite: prerequisiteId });
}

// ---------------------------------------------------------------------------------------------
// delete / restore
// ---------------------------------------------------------------------------------------------

/** Soft-deletes the task and all its subtasks. Deleted prerequisites no longer block their dependents. */
export async function deleteTask(s: TenantSession, taskId: string) {
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  need(s, "task.delete", scope);
  const kids = await descendantIds(s.tx, s.orgId, task.id);
  const ids = [task.id, ...kids];
  const now = new Date();
  await s.tx.update(tasks).set({ deletedAt: now, deletedBy: s.userId, updatedAt: now }).where(and(eq(tasks.orgId, s.orgId), inArray(tasks.id, ids)));
  await activity(s, task.id, "deleted", { subtasks: kids.length });
  await audit(s, "task.delete", task.id, { subtasks: kids.length });
  await emit(s, "task.deleted", { taskId: task.id, actorId: s.userId });
  return { deleted: ids.length };
}

export async function restoreTask(s: TenantSession, taskId: string) {
  const { task, scope } = await loadTask(s, taskId, { includeDeleted: true, forUpdate: true });
  if (!task.deletedAt) throw conflict("Task is not deleted");
  need(s, "task.delete", scope);
  if (task.parentId) {
    const [parent] = await s.tx.select({ deletedAt: tasks.deletedAt }).from(tasks).where(and(eq(tasks.orgId, s.orgId), eq(tasks.id, task.parentId)));
    if (!parent || parent.deletedAt) throw conflict("Restore the parent task first");
  }
  const kids = await descendantIds(s.tx, s.orgId, task.id, { deleted: true });
  // Only subtasks deleted together with the parent come back.
  const restorable = kids.length
    ? (await s.tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, s.orgId), inArray(tasks.id, kids), eq(tasks.deletedAt, task.deletedAt)))).map((r) => r.id)
    : [];
  try {
    await s.tx.transaction(async (sp) => {
      await sp.update(tasks).set({ deletedAt: null, deletedBy: null, updatedAt: new Date() }).where(and(eq(tasks.orgId, s.orgId), inArray(tasks.id, [task.id, ...restorable])));
    });
  } catch (e) {
    if (String((e as { cause?: unknown }).cause ?? e).includes("tasks_series_occurrence_uq")) throw conflict("An occurrence for this date already exists");
    throw e;
  }
  await activity(s, task.id, "restored");
  await audit(s, "task.restore", task.id);
  await emit(s, "task.restored", { taskId: task.id, actorId: s.userId });
  return { restored: 1 + restorable.length };
}

// ---------------------------------------------------------------------------------------------
// comments & mentions
// ---------------------------------------------------------------------------------------------

export async function addComment(s: TenantSession, taskId: string, input: { body: string; mentionUserIds?: string[] }) {
  const { task, scope } = await loadTask(s, taskId);
  need(s, "task.comment", scope);
  const body = input.body.trim();
  if (!body || body.length > 10_000) throw validation("Comment must be 1-10000 characters");

  const wanted = [...new Set(input.mentionUserIds ?? [])].slice(0, MAX_MENTIONS);
  const mentioned: string[] = [];
  for (const u of wanted) {
    if (u === s.userId) continue;
    const principal = await loadPrincipal(s.tx, u, s.orgId);
    if (principal && can(principal, "task.read", scope)) mentioned.push(u); // silently drop anyone who could not see the task
  }

  const [c] = await s.tx.insert(comments).values({ orgId: s.orgId, taskId: task.id, authorId: s.userId, body }).returning();
  if (mentioned.length) await s.tx.insert(commentMentions).values(mentioned.map((userId) => ({ orgId: s.orgId, commentId: c!.id, userId })));
  await activity(s, task.id, "commented", { commentId: c!.id });
  await emit(s, "task.commented", { taskId: task.id, commentId: c!.id, actorId: s.userId });
  if (mentioned.length) await emit(s, "task.mentioned", { taskId: task.id, commentId: c!.id, actorId: s.userId, userIds: mentioned });
  return { id: c!.id, mentioned: mentioned.length };
}

export async function listComments(s: TenantSession, taskId: string, opts: { limit?: number; offset?: number } = {}) {
  const { task, scope } = await loadTask(s, taskId);
  need(s, "task.read", scope);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const rows = await s.tx
    .select({ id: comments.id, body: comments.body, authorId: comments.authorId, authorName: users.name, createdAt: comments.createdAt, editedAt: comments.editedAt })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(and(eq(comments.orgId, s.orgId), eq(comments.taskId, task.id), isNull(comments.deletedAt)))
    .orderBy(asc(comments.createdAt), asc(comments.id))
    .limit(limit)
    .offset(Math.max(opts.offset ?? 0, 0));
  return rows;
}

export async function editComment(s: TenantSession, commentId: string, body: string) {
  const [c] = await s.tx.select().from(comments).where(and(eq(comments.orgId, s.orgId), eq(comments.id, commentId), isNull(comments.deletedAt)));
  if (!c) throw notFound();
  const { scope } = await loadTask(s, c.taskId);
  need(s, "task.comment", scope);
  if (c.authorId !== s.userId) throw forbidden({ permission: "comment.edit_other" });
  const text = body.trim();
  if (!text || text.length > 10_000) throw validation("Comment must be 1-10000 characters");
  await s.tx.update(comments).set({ body: text, editedAt: new Date() }).where(eq(comments.id, c.id));
}

export async function deleteComment(s: TenantSession, commentId: string) {
  const [c] = await s.tx.select().from(comments).where(and(eq(comments.orgId, s.orgId), eq(comments.id, commentId), isNull(comments.deletedAt)));
  if (!c) throw notFound();
  const { scope } = await loadTask(s, c.taskId);
  if (c.authorId !== s.userId) need(s, "task.delete", scope);
  await s.tx.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, c.id));
  await audit(s, "comment.delete", c.taskId, { commentId: c.id });
}

// ---------------------------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------------------------

export async function createLabel(s: TenantSession, input: { name: string; color?: string }) {
  s.require("label.manage");
  const name = input.name.trim();
  if (!name || name.length > 50) throw validation("Label name must be 1-50 characters");
  if (input.color && !/^#[0-9a-fA-F]{6}$/.test(input.color)) throw validation("Invalid color");
  const [row] = await s.tx.insert(labels).values({ orgId: s.orgId, name, ...(input.color ? { color: input.color } : {}) }).onConflictDoNothing().returning();
  if (!row) throw conflict("A label with this name already exists");
  return row;
}

export async function listLabels(s: TenantSession) {
  s.requireAny("org.read");
  return s.tx.select({ id: labels.id, name: labels.name, color: labels.color }).from(labels).where(eq(labels.orgId, s.orgId)).orderBy(asc(labels.name)).limit(500);
}

export async function setTaskLabels(s: TenantSession, taskId: string, labelIds: string[]) {
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  need(s, "task.update", scope);
  const ids = [...new Set(labelIds)];
  if (ids.length > MAX_LABELS) throw validation("Too many labels");
  await assertLabelsExist(s, ids);
  const current = (await s.tx.select({ id: taskLabels.labelId }).from(taskLabels).where(and(eq(taskLabels.orgId, s.orgId), eq(taskLabels.taskId, task.id)))).map((r) => r.id);
  if (sameSet(current, ids)) return;
  await s.tx.delete(taskLabels).where(and(eq(taskLabels.orgId, s.orgId), eq(taskLabels.taskId, task.id)));
  if (ids.length) await s.tx.insert(taskLabels).values(ids.map((labelId) => ({ orgId: s.orgId, taskId: task.id, labelId })));
  await touch(s, task.id);
  await activity(s, task.id, "labels_changed", { count: ids.length });
}

export async function setTaskCustomValues(s: TenantSession, taskId: string, values: Record<string, unknown>) {
  const { task, scope } = await loadTask(s, taskId, { forUpdate: true });
  need(s, "task.update", scope);
  await writeCustomValues(s.tx, s.orgId, task.id, values);
  await s.tx.update(tasks).set({ updatedAt: new Date(), updatedBy: s.userId }).where(eq(tasks.id, task.id));
  await activity(s, task.id, "custom_fields_changed", { fieldIds: Object.keys(values) });
}

// ---------------------------------------------------------------------------------------------
// reading
// ---------------------------------------------------------------------------------------------

export interface TaskSummary {
  id: string;
  projectId: string;
  parentId: string | null;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  startDate: string | null;
  dueDate: string | null;
  completedAt: Date | null;
  primaryAssigneeId: string | null;
  primaryAssigneeName: string | null;
  coAssigneeIds: string[];
  assignees: { id: string; name: string }[];
  labelIds: string[];
  /** What the caller may do with this particular task; used only to show or hide controls. */
  perms: { update: boolean; changeStatus: boolean; reopen: boolean };
  blockedByCount: number;
  subtaskCount: number;
  seriesId: string | null;
  customFields: Record<string, unknown>;
  version: number;
  updatedAt: Date;
}

export interface TaskFilter {
  projectId?: string;
  status?: TaskStatus[];
  priority?: TaskPriority[];
  /** user id, or "me" */
  assignee?: string;
  labelId?: string;
  dueFrom?: string;
  dueTo?: string;
  /** tasks whose [start,due] range intersects [rangeFrom, rangeTo] (calendar / timeline) */
  rangeFrom?: string;
  rangeTo?: string;
  /** substring of the title */
  q?: string;
  parentId?: string | null;
  topLevelOnly?: boolean;
  /** "YYYY-MM-DD" in the caller's zone; with `overdue`, selects open tasks due before it */
  today?: string;
  overdue?: boolean;
  sort?: "due" | "priority" | "created" | "updated" | "title";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
  /** custom field predicates (validated against the field definitions) */
  custom?: CustomFilter[];
  /** Extra SQL conditions supplied by trusted callers. */
  extra?: SQL[];
}

export const escapeLike = escapeLikeValue;

export async function listTasks(s: TenantSession, f: TaskFilter = {}): Promise<{ items: TaskSummary[]; hasMore: boolean }> {
  const accessible = await accessibleProjectIds(s, "task.read");
  if (Array.isArray(accessible) && accessible.length === 0) return { items: [], hasMore: false };

  const conds: (SQL | undefined)[] = [eq(tasks.orgId, s.orgId), isNull(tasks.deletedAt)];
  if (Array.isArray(accessible)) conds.push(inArray(tasks.projectId, accessible));
  if (f.projectId) conds.push(eq(tasks.projectId, f.projectId));
  if (f.status?.length) conds.push(inArray(tasks.status, f.status));
  if (f.priority?.length) conds.push(inArray(tasks.priority, f.priority));
  if (f.assignee) {
    const uid = f.assignee === "me" ? s.userId : f.assignee;
    // an IN-subquery is run once as a hashed set; a correlated EXISTS would probe task_assignees once per candidate task
    conds.push(or(eq(tasks.primaryAssigneeId, uid), sql`${tasks.id} in (select a.task_id from task_assignees a where a.org_id = ${s.orgId} and a.user_id = ${uid})`));
  }
  if (f.labelId) conds.push(sql`exists (select 1 from task_labels l where l.task_id = ${tasks.id} and l.org_id = ${tasks.orgId} and l.label_id = ${f.labelId})`);
  if (f.dueFrom) conds.push(gte(tasks.dueDate, f.dueFrom));
  if (f.dueTo) conds.push(lte(tasks.dueDate, f.dueTo));
  if (f.rangeFrom && f.rangeTo) {
    // Date-bearing tasks whose [start, due] span (either end may be missing) intersects the window.
    conds.push(or(isNotNull(tasks.dueDate), isNotNull(tasks.startDate)));
    conds.push(gte(sql`coalesce(${tasks.dueDate}, ${tasks.startDate})`, f.rangeFrom));
    conds.push(lte(sql`coalesce(${tasks.startDate}, ${tasks.dueDate})`, f.rangeTo));
  }
  if (f.q) conds.push(ilike(tasks.title, `%${escapeLike(f.q.trim())}%`));
  if (f.parentId) conds.push(eq(tasks.parentId, f.parentId));
  if (f.topLevelOnly) conds.push(isNull(tasks.parentId));
  if (f.overdue && f.today) conds.push(and(isNotNull(tasks.dueDate), sql`${tasks.dueDate} < ${f.today}`, notInArray(tasks.status, ["done", "cancelled"])));
  for (const x of await customFilterConditions(s.tx, s.orgId, f.custom ?? [])) conds.push(x);
  for (const x of f.extra ?? []) conds.push(x);

  const dir = f.order === "desc" ? desc : asc;
  const orderBy =
    f.sort === "priority" ? [desc(tasks.priority), sql`${tasks.dueDate} asc nulls last`, asc(tasks.id)]
    : f.sort === "created" ? [dir(tasks.createdAt), asc(tasks.id)]
    : f.sort === "updated" ? [dir(tasks.updatedAt), asc(tasks.id)]
    : f.sort === "title" ? [dir(tasks.title), asc(tasks.id)]
    : [f.order === "desc" ? sql`${tasks.dueDate} desc nulls last` : sql`${tasks.dueDate} asc nulls last`, desc(tasks.priority), asc(tasks.id)];

  const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
  const rows = await s.tx.select().from(tasks).where(and(...conds)).orderBy(...orderBy).limit(limit + 1).offset(Math.min(Math.max(f.offset ?? 0, 0), 10_000));
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { items: await hydrate(s, page), hasMore };
}

async function hydrate(s: TenantSession, rows: TaskRow[]): Promise<TaskSummary[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  // Sequential on purpose: all queries share one transaction connection.
  const co = await s.tx.select({ taskId: taskAssignees.taskId, userId: taskAssignees.userId }).from(taskAssignees).where(and(eq(taskAssignees.orgId, s.orgId), inArray(taskAssignees.taskId, ids)));
  const lbl = await s.tx.select({ taskId: taskLabels.taskId, labelId: taskLabels.labelId }).from(taskLabels).where(and(eq(taskLabels.orgId, s.orgId), inArray(taskLabels.taskId, ids)));
  const blocked = await s.tx
    .select({ taskId: taskDependencies.taskId, n: sql<number>`count(*)::int` })
    .from(taskDependencies)
    .innerJoin(tasks, and(eq(tasks.orgId, taskDependencies.orgId), eq(tasks.id, taskDependencies.dependsOnId)))
    .where(and(eq(taskDependencies.orgId, s.orgId), inArray(taskDependencies.taskId, ids), isNull(tasks.deletedAt), ne(tasks.status, "done")))
    .groupBy(taskDependencies.taskId);
  const kids = await s.tx
    .select({ parentId: tasks.parentId, n: sql<number>`count(*)::int` })
    .from(tasks)
    .where(and(eq(tasks.orgId, s.orgId), inArray(tasks.parentId, ids), isNull(tasks.deletedAt)))
    .groupBy(tasks.parentId);
  const custom = await valuesForTasks(s.tx, s.orgId, ids);
  const nameIds = [...new Set([...rows.map((r) => r.primaryAssigneeId), ...co.map((x) => x.userId)].filter((x): x is string => !!x))];
  const names = new Map((nameIds.length ? await s.tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, nameIds)) : []).map((u) => [u.id, u.name]));
  const scopes = await projectScopes(s, [...new Set(rows.map((r) => r.projectId))]);
  return rows.map((r) => ({
    id: r.id, projectId: r.projectId, parentId: r.parentId, title: r.title, status: r.status, priority: r.priority,
    startDate: r.startDate, dueDate: r.dueDate, completedAt: r.completedAt, primaryAssigneeId: r.primaryAssigneeId,
    primaryAssigneeName: r.primaryAssigneeId ? names.get(r.primaryAssigneeId) ?? null : null,
    coAssigneeIds: co.filter((x) => x.taskId === r.id).map((x) => x.userId),
    assignees: [...(r.primaryAssigneeId ? [r.primaryAssigneeId] : []), ...co.filter((x) => x.taskId === r.id).map((x) => x.userId)].map((id) => ({ id, name: names.get(id) ?? "" })),
    perms: {
      update: can(s.principal, "task.update", scopes.get(r.projectId)!),
      changeStatus: can(s.principal, "task.change_status", scopes.get(r.projectId)!),
      reopen: can(s.principal, "task.reopen", scopes.get(r.projectId)!),
    },
    labelIds: lbl.filter((x) => x.taskId === r.id).map((x) => x.labelId),
    blockedByCount: blocked.find((x) => x.taskId === r.id)?.n ?? 0,
    subtaskCount: kids.find((x) => x.parentId === r.id)?.n ?? 0,
    seriesId: r.seriesId, customFields: custom.get(r.id) ?? {}, version: r.version, updatedAt: r.updatedAt,
  }));
}

export async function getTask(s: TenantSession, taskId: string) {
  const { task, scope } = await loadTask(s, taskId);
  const [summary] = await hydrate(s, [task]);
  const subtasks = await s.tx
    .select({ id: tasks.id, title: tasks.title, status: tasks.status, dueDate: tasks.dueDate })
    .from(tasks)
    .where(and(eq(tasks.orgId, s.orgId), eq(tasks.parentId, task.id), isNull(tasks.deletedAt)))
    .orderBy(asc(tasks.createdAt))
    .limit(200);
  const deps = await s.tx
    .select({ id: tasks.id, projectId: tasks.projectId, title: tasks.title, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, and(eq(tasks.orgId, taskDependencies.orgId), eq(tasks.id, taskDependencies.dependsOnId)))
    .where(and(eq(taskDependencies.orgId, s.orgId), eq(taskDependencies.taskId, task.id), isNull(tasks.deletedAt)));
  const dependents = await s.tx
    .select({ id: tasks.id, projectId: tasks.projectId, title: tasks.title, status: tasks.status })
    .from(taskDependencies)
    .innerJoin(tasks, and(eq(tasks.orgId, taskDependencies.orgId), eq(tasks.id, taskDependencies.taskId)))
    .where(and(eq(taskDependencies.orgId, s.orgId), eq(taskDependencies.dependsOnId, task.id), isNull(tasks.deletedAt)));

  // Linked tasks in projects the caller cannot read are shown as opaque placeholders, without title or status.
  const scopes = await projectScopes(s, [...new Set([...deps, ...dependents].map((d) => d.projectId))]);
  const view = (d: { id: string; projectId: string; title: string; status: TaskStatus }) =>
    can(s.principal, "task.read", scopes.get(d.projectId)!) ? { id: d.id, title: d.title, status: d.status, restricted: false } : { id: d.id, restricted: true as const };

  return {
    ...summary!,
    description: task.description,
    reminderDaysBefore: task.reminderDaysBefore,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    subtasks,
    prerequisites: deps.map(view),
    dependents: dependents.map(view),
    permissions: {
      update: can(s.principal, "task.update", scope),
      changeStatus: can(s.principal, "task.change_status", scope),
      assign: can(s.principal, "task.assign", scope),
      delete: can(s.principal, "task.delete", scope),
      comment: can(s.principal, "task.comment", scope),
      reopen: can(s.principal, "task.reopen", scope),
      manageDependencies: can(s.principal, "task.manage_dependencies", scope),
      attach: can(s.principal, "task.attach", scope),
    },
  };
}

export async function getActivity(s: TenantSession, taskId: string, opts: { limit?: number; offset?: number } = {}) {
  const { task } = await loadTask(s, taskId);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  return s.tx
    .select({ id: taskActivity.id, type: taskActivity.type, changes: taskActivity.changes, actorId: taskActivity.actorId, createdAt: taskActivity.createdAt })
    .from(taskActivity)
    .where(and(eq(taskActivity.orgId, s.orgId), eq(taskActivity.taskId, task.id)))
    .orderBy(desc(taskActivity.createdAt), desc(taskActivity.id))
    .limit(limit)
    .offset(Math.max(opts.offset ?? 0, 0));
}

export { isTerminal };

/** Sets the primary assignee while preserving co-assignees (used by bulk actions). */
export async function setPrimaryAssignee(s: TenantSession, taskId: string, userId: string | null) {
  const co = (await s.tx.select({ userId: taskAssignees.userId }).from(taskAssignees).where(and(eq(taskAssignees.orgId, s.orgId), eq(taskAssignees.taskId, taskId)))).map((r) => r.userId);
  return setAssignees(s, taskId, { primary: userId, co: co.filter((u) => u !== userId) });
}
