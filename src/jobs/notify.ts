import { and, eq, inArray, isNull } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import type { Tx } from "@/db/client";
import { notificationSettings, notifications, organizations, projects, tasks, users } from "@/db/schema";
import { defaultEnabled, type Channel, type NotificationType } from "@/domain/notifications";
import { asEmailSchedule, nextDailyEmailAt } from "@/domain/email-schedule";
import { DEFAULT_LOCALE, isLocale, t, type Locale } from "@/i18n";
import { formatDate } from "@/domain/time";
import { projectScope, projectScopes } from "@/data/scope";
import { loadPrincipal, loadPrincipals } from "@/data/tenant";
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
  /** The recipient has e-mail switched on for this event (see notifications.email_wanted). */
  emailWanted?: boolean;
}

/** Inserts a notification; returns its id, or null if an identical one (same dedupe key) already exists. */
export async function insertNotification(tx: Tx, n: NewNotification): Promise<string | null> {
  const rows = await tx
    .insert(notifications)
    .values({ orgId: n.orgId, userId: n.userId, type: n.type, taskId: n.taskId, actorId: n.actorId ?? null, params: n.params ?? {}, dedupeKey: n.dedupeKey, inApp: n.inApp ?? true, emailWanted: n.emailWanted ?? false })
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

export interface RenderInput { userId: string; type: string; taskId: string | null; actorId: string | null; params: Record<string, string> }

function textFor(locale: Locale, n: RenderInput, task: TaskRow, actor: string): string | null {
  const p = n.params;
  const vars = { actor, task: task.title };
  switch (n.type) {
    case "task.assigned": return t(locale, "notify.assigned", vars);
    case "task.unassigned": return t(locale, "notify.unassigned", vars);
    case "task.commented": return t(locale, "notify.comment", vars);
    case "task.mentioned": return t(locale, "notify.mention", vars);
    case "task.status_changed": return t(locale, "notify.status", { task: task.title, status: statusLabel(locale, p.status) });
    case "task.priority_changed": return t(locale, "notify.priority", { task: task.title, priority: priorityLabel(locale, p.priority) });
    case "task.due_soon": return t(locale, "notify.due_soon", { task: task.title, date: p.dueDate ? formatDate(p.dueDate, locale) : "" });
    case "task.overdue": return t(locale, "notify.overdue", { task: task.title, date: p.dueDate ? formatDate(p.dueDate, locale) : "" });
    case "task.dependency_changed": return t(locale, "notify.dependency", { task: task.title, status: statusLabel(locale, p.status) });
    default: return null;
  }
}

/**
 * Turns stored notifications into text for `locale`, in a handful of queries however many there are (tasks, project scopes,
 * recipients' permissions and actor names are each loaded once). Access is checked NOW, per notification: if the recipient has lost
 * access, or the task is gone, the result is a generic line with no title, so a stale notification can never leak data.
 * The result has one entry per input, in the same order.
 */
export async function renderNotifications(tx: Tx, orgId: string, notes: RenderInput[], locale: Locale): Promise<Rendered[]> {
  const hidden = (): Rendered => ({ text: t(locale, "notify.generic_hidden"), visible: false, taskId: null, title: null });
  const taskIds = [...new Set(notes.map((n) => n.taskId).filter((x): x is string => !!x))];
  if (!taskIds.length) return notes.map(hidden);

  const taskRows = await tx.select().from(tasks).where(and(eq(tasks.orgId, orgId), inArray(tasks.id, taskIds)));
  const byId = new Map(taskRows.filter((r) => !r.deletedAt).map((r) => [r.id, r]));
  const projectIds = [...new Set([...byId.values()].map((r) => r.projectId))];
  // a deleted project hides its tasks, as it does everywhere else (projectScope returns null for it)
  const live = new Set(projectIds.length ? (await tx.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, orgId), inArray(projects.id, projectIds), isNull(projects.deletedAt)))).map((r) => r.id) : []);
  const scopes = await projectScopes({ tx, orgId }, [...live]);
  const principals = await loadPrincipals(tx, [...new Set(notes.map((n) => n.userId))], orgId);
  const actors = await loadProfiles(tx, [...new Set(notes.map((n) => n.actorId).filter((x): x is string => !!x))]);

  return notes.map((n) => {
    const task = n.taskId ? byId.get(n.taskId) : undefined;
    if (!task) return hidden();
    const scope = scopes.get(task.projectId);
    const principal = principals.get(n.userId);
    if (!scope || !principal || !can(principal, "task.read", scope)) return hidden();
    const text = textFor(locale, n, task, n.actorId ? actors.get(n.actorId)?.name ?? "" : "");
    return text === null ? hidden() : { text, visible: true, taskId: task.id, title: task.title };
  });
}

/** One notification; see `renderNotifications`. */
export async function renderNotification(tx: Tx, orgId: string, n: RenderInput, locale: Locale): Promise<Rendered> {
  return (await renderNotifications(tx, orgId, [n], locale))[0]!;
}

const statusLabel = (l: Locale, v?: string) => (v ? t(l, `status.${v}` as never) : "");
const priorityLabel = (l: Locale, v?: string) => (v ? t(l, `priority.${v}` as never) : "");

const COMBINED_EMAIL: ReadonlySet<NotificationType> = new Set<NotificationType>(["task.due_soon", "task.overdue"]);

/**
 * How the organization's e-mail goes out (Settings -> Notifications), read where the work starts, once per event or scan: `autoEmail` is the
 * switch, and `emailAt` is when an automatic e-mail created `now` is sent (right away, or in daily mode at 23:00 Thai time).
 */
export async function orgEmailDelivery(tx: Tx, orgId: string, now: Date): Promise<{ autoEmail: boolean; emailAt: Date }> {
  const [o] = await tx.select({ auto: organizations.autoEmail, schedule: organizations.emailSchedule }).from(organizations).where(eq(organizations.id, orgId));
  const autoEmail = o?.auto === true;
  return { autoEmail, emailAt: autoEmail && asEmailSchedule(o?.schedule) === "daily" ? nextDailyEmailAt(now) : now };
}

/**
 * Creates notifications for `userIds` about `task`. With `autoEmail` (see orgEmailDelivery) it also queues the email deliveries; without it the
 * e-mail is only recorded as wanted (`emailWanted`) and waits until an administrator sends the waiting e-mails
 * (src/data/notification-emails.ts). Notifications inside the app are created either way.
 * Only people who can read the task right now are notified; in-app/email switches are honoured per user.
 * Idempotent: the same `key` for the same recipient never produces a second notification.
 */
export async function deliverToUsers(
  tx: Tx,
  o: { orgId: string; task: TaskRow; type: NotificationType; userIds: string[]; actorId?: string | null; params?: Record<string, string>; key: string; now: Date; autoEmail: boolean; /** when the e-mail job may run (default: now); see orgEmailDelivery */ emailAt?: Date },
): Promise<number> {
  if (o.task.deletedAt) return 0;
  const candidates = [...new Set(o.userIds)].filter((u) => u !== o.actorId);
  const readers = [...(await readersOf(tx, o.orgId, o.task, candidates))];
  const inApp = await enabledUsers(tx, o.orgId, readers, "in_app", o.type);
  // Due-soon and overdue reminders are not e-mailed one task at a time: they are combined into one e-mail a day (handlers/deadline.ts).
  const wantsEmail = await enabledUsers(tx, o.orgId, readers, "email", o.type);
  const email = COMBINED_EMAIL.has(o.type) ? new Set<string>() : wantsEmail;
  let created = 0;
  for (const userId of readers) {
    if (!inApp.has(userId) && !email.has(userId)) {
      // No row: this person gets the combined deadline e-mail instead of a notification. It still counts as "handled" so that what follows a
      // reminder (the Discord message, whose own job key keeps it from going twice) does not depend on the bell being switched on.
      if (COMBINED_EMAIL.has(o.type) && wantsEmail.has(userId)) created++;
      continue;
    }
    const id = await insertNotification(tx, { orgId: o.orgId, userId, type: o.type, taskId: o.task.id, actorId: o.actorId ?? null, params: o.params, dedupeKey: o.key, inApp: inApp.has(userId), emailWanted: email.has(userId) });
    if (!id) continue;
    created++;
    if (email.has(userId) && o.autoEmail) await enqueue(tx, { kind: "notification.email", orgId: o.orgId, payload: { notificationId: id }, dedupeKey: `email:${id}`, maxAttempts: 8, runAt: o.emailAt ?? o.now });
  }
  return created;
}
