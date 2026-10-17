import { and, eq, inArray } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import type { Tx } from "@/db/client";
import { notificationSettings, notifications, tasks, users } from "@/db/schema";
import { defaultEnabled, type Channel, type NotificationType } from "@/domain/notifications";
import { DEFAULT_LOCALE, isLocale, t, type Locale } from "@/i18n";
import { formatDate } from "@/domain/time";
import { projectScope } from "@/data/scope";
import { loadPrincipal } from "@/data/tenant";
import { enqueue } from "./queue";

type TaskRow = typeof tasks.$inferSelect;

export interface UserProfile {
  id: string;
  email: string;
  name: string;
  locale: Locale;
  timezone: string;
  deleted: boolean;
}

export async function loadProfiles(tx: Tx, ids: string[]): Promise<Map<string, UserProfile>> {
  const out = new Map<string, UserProfile>();
  if (!ids.length) return out;
  const rows = await tx.select({ id: users.id, email: users.email, name: users.name, locale: users.locale, timezone: users.timezone, deletedAt: users.deletedAt }).from(users).where(inArray(users.id, ids));
  for (const r of rows) out.set(r.id, { id: r.id, email: r.email, name: r.name, locale: isLocale(r.locale) ? r.locale : DEFAULT_LOCALE, timezone: r.timezone, deleted: !!r.deletedAt });
  return out;
}

/** Who, among `userIds`, may *currently* read this task. Checked again at every delivery step. */
export async function readersOf(tx: Tx, orgId: string, task: Pick<TaskRow, "projectId">, userIds: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const scope = await projectScope({ tx, orgId }, task.projectId);
  if (!scope) return out;
  for (const id of new Set(userIds)) {
    const principal = await loadPrincipal(tx, id, orgId);
    if (principal && can(principal, "task.read", scope)) out.add(id);
  }
  return out;
}

export async function enabledUsers(tx: Tx, orgId: string, userIds: string[], channel: Channel, type: NotificationType): Promise<Set<string>> {
  const out = new Set<string>();
  if (!userIds.length) return out;
  const rows = await tx
    .select({ userId: notificationSettings.userId, enabled: notificationSettings.enabled })
    .from(notificationSettings)
    .where(and(eq(notificationSettings.orgId, orgId), inArray(notificationSettings.userId, userIds), eq(notificationSettings.channel, channel), eq(notificationSettings.event, type)));
  const explicit = new Map(rows.map((r) => [r.userId, r.enabled]));
  for (const id of userIds) if (explicit.get(id) ?? defaultEnabled(channel, type)) out.add(id);
  return out;
}

export interface NewNotification {
  orgId: string;
  userId: string;
  type: NotificationType;
  taskId: string | null;
  actorId?: string | null;
  params?: Record<string, string>;
  dedupeKey: string;
  inApp?: boolean;
}

/** Inserts a notification; returns its id, or null if an identical one (same dedupe key) already exists. */
export async function insertNotification(tx: Tx, n: NewNotification): Promise<string | null> {
  const rows = await tx
    .insert(notifications)
    .values({ orgId: n.orgId, userId: n.userId, type: n.type, taskId: n.taskId, actorId: n.actorId ?? null, params: n.params ?? {}, dedupeKey: n.dedupeKey, inApp: n.inApp ?? true })
    .onConflictDoNothing({ target: [notifications.userId, notifications.dedupeKey] })
    .returning({ id: notifications.id });
  return rows[0]?.id ?? null;
}

export interface Rendered {
  text: string;
  /** false when the recipient can no longer see the underlying task; text is then generic and carries no task data */
  visible: boolean;
  taskId: string | null;
  title: string | null;
}

/**
 * Turns a stored notification into text for `locale`. Access is checked NOW: if the recipient has lost
 * access, or the task is gone, the result is a generic line with no title, so a stale notification can
 * never leak data.
 */
export async function renderNotification(
  tx: Tx,
  orgId: string,
  n: { userId: string; type: string; taskId: string | null; actorId: string | null; params: Record<string, string> },
  locale: Locale,
): Promise<Rendered> {
  const hidden: Rendered = { text: t(locale, "notify.generic_hidden"), visible: false, taskId: null, title: null };
  if (!n.taskId) return hidden;
  const [task] = await tx.select().from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.id, n.taskId)));
  if (!task || task.deletedAt) return hidden;
  if (!(await readersOf(tx, orgId, task, [n.userId])).has(n.userId)) return hidden;

  const actor = n.actorId ? (await loadProfiles(tx, [n.actorId])).get(n.actorId)?.name ?? "" : "";
  const p = n.params;
  const vars = { actor, task: task.title };
  let text: string;
  switch (n.type) {
    case "task.assigned": text = t(locale, "notify.assigned", vars); break;
    case "task.unassigned": text = t(locale, "notify.unassigned", vars); break;
    case "task.commented": text = t(locale, "notify.comment", vars); break;
    case "task.mentioned": text = t(locale, "notify.mention", vars); break;
    case "task.status_changed": text = t(locale, "notify.status", { task: task.title, status: statusLabel(locale, p.status) }); break;
    case "task.priority_changed": text = t(locale, "notify.priority", { task: task.title, priority: priorityLabel(locale, p.priority) }); break;
    case "task.due_soon": text = t(locale, "notify.due_soon", { task: task.title, date: p.dueDate ? formatDate(p.dueDate, locale) : "" }); break;
    case "task.overdue": text = t(locale, "notify.overdue", { task: task.title, date: p.dueDate ? formatDate(p.dueDate, locale) : "" }); break;
    case "task.dependency_changed": text = t(locale, "notify.dependency", { task: task.title, status: statusLabel(locale, p.status) }); break;
    default: return hidden;
  }
  return { text, visible: true, taskId: task.id, title: task.title };
}

const statusLabel = (l: Locale, v?: string) => (v ? t(l, `status.${v}` as never) : "");
const priorityLabel = (l: Locale, v?: string) => (v ? t(l, `priority.${v}` as never) : "");

/**
 * Creates notifications for `userIds` about `task` and queues the email deliveries.
 * Only people who can read the task right now are notified; in-app/email switches are honoured per user.
 * Idempotent: the same `key` for the same recipient never produces a second notification.
 */
export async function deliverToUsers(
  tx: Tx,
  o: { orgId: string; task: TaskRow; type: NotificationType; userIds: string[]; actorId?: string | null; params?: Record<string, string>; key: string; now: Date },
): Promise<number> {
  if (o.task.deletedAt) return 0;
  const candidates = [...new Set(o.userIds)].filter((u) => u !== o.actorId);
  const readers = [...(await readersOf(tx, o.orgId, o.task, candidates))];
  const inApp = await enabledUsers(tx, o.orgId, readers, "in_app", o.type);
  const email = await enabledUsers(tx, o.orgId, readers, "email", o.type);
  let created = 0;
  for (const userId of readers) {
    if (!inApp.has(userId) && !email.has(userId)) continue;
    const id = await insertNotification(tx, { orgId: o.orgId, userId, type: o.type, taskId: o.task.id, actorId: o.actorId ?? null, params: o.params, dedupeKey: o.key, inApp: inApp.has(userId) });
    if (!id) continue;
    created++;
    if (email.has(userId)) await enqueue(tx, { kind: "notification.email", orgId: o.orgId, payload: { notificationId: id }, dedupeKey: `email:${id}`, maxAttempts: 8, runAt: o.now });
  }
  return created;
}
