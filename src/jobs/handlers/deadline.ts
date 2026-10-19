import { and, desc, eq, inArray, isNotNull, isNull, lte, notInArray } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import { digestLog, notificationPrefs, organizations, projects, taskAssignees, tasks } from "@/db/schema";
import { projectScopes } from "@/data/scope";
import { loadPrincipals } from "@/data/tenant";
import { digestPeriod, quietHoursEnd } from "@/domain/notifications";
import { addDays, formatDate } from "@/domain/time";
import { renderEmail, type Section, type TaskLine } from "@/integrations/email/templates";
import { EmailError } from "@/integrations/email";
import { t, type Locale } from "@/i18n";
import { logger } from "@/lib/logger";
import { myTasksLink, taskLink } from "@/lib/links";
import { withWorker, withWorkerOrg } from "../context";
import { enabledUsers, loadProfiles } from "../notify";
import { Deferred, type JobContext, type JobHandler } from "../worker";

/** A period of the deadline e-mail begins at this local hour (the same hour the per-task reminders use). */
export const DEADLINE_SEND_HOUR = 9;
/** Tasks listed in one e-mail; the counts in the subject and in each section title are always the full numbers. */
export const DEADLINE_MAX_LISTED = 30;
/** Tasks read per organization, the most recently due first. */
const PER_ORG_LIMIT = 5000;
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

type Kind = "overdue" | "today" | "tomorrow";
interface Item { id: string; title: string; projectName: string; status: string; priority: string; dueDate: string; kind: Kind; daysOver: number }
interface Plan { userId: string; email: string; name: string; locale: Locale; periodKey: string; items: Item[] }
type OrgResult = { retry: boolean; late: boolean; stop: boolean };

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * One e-mail per person per period listing their unfinished tasks that are overdue, due today or due tomorrow (at most DEADLINE_MAX_LISTED, today's first); nobody without
 * such a task is e-mailed. Replaces a separate e-mail for each task.
 *
 * Which tasks: the person is the primary or a co-assignee, the status is neither done nor cancelled, the project is not deleted and the
 * person can still read it. What goes in: the person's own e-mail choices for "due soon" (today and tomorrow) and "overdue".
 *
 * A period (digestPeriod, 09:00 local) is the unit of "one a day", and the tasks are judged against the period's own date, so what is sent
 * and what is claimed always refer to the same day: a frequent scheduler finds nothing new before 09:00 (that is the picture it already
 * sent, or found empty, at 09:00 the day before) and sends once at 09:00; a scheduler that runs once a day at any hour, even before 09:00 local,
 * still reaches the person once a day, with that day's picture. The period is claimed in digest_log in the same transaction as the send: two runs
 * cannot both send, and a failed send gives the claim back for the next run.
 *
 * Runs for the organizations that switched automatic e-mail on; a job queued by an administrator for ONE organization (job.orgId with
 * payload.manual, from the "send waiting e-mails" button) runs for that organization whatever its switch says.
 */
export const deadlineEmail: JobHandler = async (ctx, job) => {
  const only = job.orgId && job.payload.manual === true ? job.orgId : null;
  const orgs = await withWorker(ctx.db, (tx) =>
    tx.select({ id: organizations.id }).from(organizations).where(and(isNull(organizations.deletedAt), only ? eq(organizations.id, only) : eq(organizations.autoEmail, true))),
  );
  let retry = false;
  let late = false;
  let first = true;
  for (const org of orgs) {
    if (!first && ctx.deadline && Date.now() > ctx.deadline) { late = true; break; }
    first = false;
    try {
      const r = await deadlineForOrg(ctx, org.id);
      retry ||= r.retry;
      late ||= r.late;
      if (r.stop) break; // the provider refuses us as a whole (bad key, unverified domain): no point in trying every other person
    } catch (e) {
      retry = true;
      logger.error({ orgId: org.id, err: e instanceof Error ? e.constructor.name : "unknown" }, "deadline e-mails failed for an organization");
    }
  }
  // a real failure counts as a failed try (back-off, then dead, then the health check says so); running out of time is just "not now"
  if (retry) throw new Error("DeadlineEmailIncomplete");
  if (late) throw new Deferred(new Date(Date.now() + 60_000), "deadline e-mails ran out of time");
};

async function deadlineForOrg(ctx: JobContext, orgId: string): Promise<OrgResult> {
  const now = ctx.now();
  const plans = await withWorkerOrg(ctx.db, orgId, (tx) => collect(tx, orgId, now));
  const out: OrgResult = { retry: false, late: false, stop: false };
  let attempted = 0;
  for (const p of plans) {
    if (attempted > 0 && ctx.deadline && Date.now() > ctx.deadline) { out.late = true; break; } // always at least one person per run, so a run makes progress
    attempted++;
    try {
      await withWorkerOrg(ctx.db, orgId, async (tx) => {
        const claimed = await tx.insert(digestLog).values({ orgId, userId: p.userId, periodKey: p.periodKey }).onConflictDoNothing().returning({ k: digestLog.periodKey });
        if (!claimed[0]) return; // already e-mailed for this period
        const mail = compose(ctx, orgId, p);
        try {
          await ctx.email.send({ to: p.email, subject: mail.subject, text: mail.text, html: mail.html, idempotencyKey: `deadline-${orgId}-${p.userId}-${p.periodKey}` });
        } catch (e) {
          // the provider refuses THIS address (invalid, suppressed): keep the claim, so it is not tried again every hour of the period
          if (e instanceof EmailError && !e.retryable && (e.status === 400 || e.status === 422)) { logger.warn({ orgId }, "deadline e-mail: address refused by the provider"); return; }
          throw e;
        }
      });
    } catch (e) {
      if (e instanceof EmailError && (e.status === 401 || e.status === 403)) {
        out.retry = true; out.stop = true; // our account with the provider, not this person: the claim was rolled back, the job backs off
        logger.error({ orgId, status: e.status }, "deadline e-mail: the provider refuses our account");
        break;
      }
      // one person's failure must not stop the others; a rejection that is not about the address or the account is not worth retrying the job for
      if (e instanceof EmailError && !e.retryable) logger.warn({ orgId }, "deadline e-mail rejected by the provider");
      else { out.retry = true; logger.warn({ orgId, err: e instanceof Error ? e.constructor.name : "unknown" }, "deadline e-mail not sent"); }
    }
  }
  return out;
}

async function collect(tx: Parameters<Parameters<typeof withWorkerOrg>[2]>[0], orgId: string, now: Date): Promise<Plan[]> {
  const utcToday = now.toISOString().slice(0, 10);
  // two days past UTC's today covers "tomorrow" in every time zone; the most recently due come first, so a huge backlog cannot push today's tasks out
  const rows = await tx
    .select()
    .from(tasks)
    .where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), notInArray(tasks.status, ["done", "cancelled"]), isNotNull(tasks.dueDate), lte(tasks.dueDate, addDays(utcToday, 2))))
    .orderBy(desc(tasks.dueDate))
    .limit(PER_ORG_LIMIT);
  if (!rows.length) return [];
  if (rows.length === PER_ORG_LIMIT) logger.warn({ orgId }, "deadline e-mail: task limit reached, the longest overdue are left out");

  const co = await tx.select({ taskId: taskAssignees.taskId, userId: taskAssignees.userId }).from(taskAssignees).where(and(eq(taskAssignees.orgId, orgId), inArray(taskAssignees.taskId, rows.map((r) => r.id))));
  const byUser = new Map<string, typeof rows>();
  const add = (userId: string | null, task: (typeof rows)[number]) => {
    if (!userId) return;
    const list = byUser.get(userId) ?? byUser.set(userId, []).get(userId)!;
    if (!list.some((x) => x.id === task.id)) list.push(task);
  };
  const taskById = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) add(r.primaryAssigneeId, r);
  for (const c of co) add(c.userId, taskById.get(c.taskId)!);
  const userIds = [...byUser.keys()];
  if (!userIds.length) return [];

  const projectIds = [...new Set(rows.map((r) => r.projectId))];
  const live = new Map((await tx.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.orgId, orgId), inArray(projects.id, projectIds), isNull(projects.deletedAt)))).map((p) => [p.id, p.name]));
  const scopes = await projectScopes({ tx, orgId }, [...live.keys()]);
  const principals = await loadPrincipals(tx, userIds, orgId);
  const profiles = await loadProfiles(tx, userIds);
  const wantsOverdue = await enabledUsers(tx, orgId, userIds, "email", "task.overdue");
  const wantsSoon = await enabledUsers(tx, orgId, userIds, "email", "task.due_soon");
  const prefs = new Map((await tx.select().from(notificationPrefs).where(and(eq(notificationPrefs.orgId, orgId), inArray(notificationPrefs.userId, userIds)))).map((p) => [p.userId, p]));

  const plans: Plan[] = [];
  for (const [userId, list] of byUser) {
    const profile = profiles.get(userId);
    const principal = principals.get(userId);
    if (!profile || profile.deleted || !principal) continue; // membership status is checked by can() below
    const q = prefs.get(userId);
    if (q?.quietStart && q.quietEnd && quietHoursEnd(now, profile.timezone, q.quietStart, q.quietEnd)) continue; // not now; a later run sends it

    const period = digestPeriod(now, profile.timezone, "daily", DEADLINE_SEND_HOUR);
    const today = period.key.slice("daily:".length); // the date the period belongs to: what is sent and what is claimed are the same day
    const tomorrow = addDays(today, 1);
    const items: Item[] = [];
    for (const task of list) {
      const scope = scopes.get(task.projectId);
      const projectName = live.get(task.projectId);
      if (!scope || projectName === undefined || !can(principal, "task.read", scope)) continue;
      const due = task.dueDate!;
      const kind: Kind | null = due < today ? "overdue" : due === today ? "today" : due === tomorrow ? "tomorrow" : null;
      if (!kind) continue;
      if (kind === "overdue" ? !wantsOverdue.has(userId) : !wantsSoon.has(userId)) continue;
      items.push({ id: task.id, title: task.title, projectName, status: task.status, priority: task.priority, dueDate: due, kind, daysOver: kind === "overdue" ? daysBetween(due, today) : 0 });
    }
    if (!items.length) continue;
    items.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || a.title.localeCompare(b.title));
    plans.push({ userId, email: profile.email, name: profile.name, locale: profile.locale, periodKey: `deadline:${period.key}`, items });
  }
  if (!plans.length) return plans;

  // people already served for their period cost nothing (the claim at send time stays as the guard against two runs at once)
  const served = new Set(
    (await tx.select({ u: digestLog.userId, k: digestLog.periodKey }).from(digestLog).where(and(eq(digestLog.orgId, orgId), inArray(digestLog.userId, plans.map((p) => p.userId)), inArray(digestLog.periodKey, [...new Set(plans.map((p) => p.periodKey))])))).map((r) => `${r.u}|${r.k}`),
  );
  return plans.filter((p) => !served.has(`${p.userId}|${p.periodKey}`));
}

/** The message for one person; exported for tests and the screenshots. */
export function compose(ctx: Pick<JobContext, "appUrl">, orgId: string, p: Pick<Plan, "locale" | "name" | "items">): { subject: string; text: string; html: string } {
  const l = p.locale;
  const app = t(l, "app.name");
  const count = (k: Kind) => p.items.filter((i) => i.kind === k).length;
  const summary = ([["overdue", "deadline.part_overdue"], ["today", "deadline.part_today"], ["tomorrow", "deadline.part_tomorrow"]] as const)
    .filter(([k]) => count(k) > 0)
    .map(([k, key]) => t(l, key, { n: count(k) }))
    .join(", ");

  // when there are more than fit: today first, then tomorrow, then overdue with the most recently due first (a backlog of old tasks must not
  // push out what is due now); shown in the usual order, oldest first, within each section
  const rank = (k: Kind) => (k === "today" ? 0 : k === "tomorrow" ? 1 : 2);
  const chosen = new Set(
    [...p.items]
      .sort((a, b) => rank(a.kind) - rank(b.kind) || (a.kind === "overdue" ? b.dueDate.localeCompare(a.dueDate) : a.dueDate.localeCompare(b.dueDate)) || (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9) || a.title.localeCompare(b.title))
      .slice(0, DEADLINE_MAX_LISTED)
      .map((i) => i.id),
  );
  const listed = p.items.filter((i) => chosen.has(i.id));
  const line = (i: Item): TaskLine => ({
    title: i.title,
    url: taskLink(ctx.appUrl, orgId, i.id),
    details: [t(l, "deadline.project", { name: i.projectName }), t(l, "deadline.status", { name: t(l, `status.${i.status}` as never) }), t(l, "deadline.priority", { name: t(l, `priority.${i.priority}` as never) }), t(l, "deadline.due_on", { date: formatDate(i.dueDate, l) })],
    due: i.kind === "overdue" ? t(l, "deadline.overdue_days", { n: i.daysOver }) : i.kind === "today" ? t(l, "deadline.due_today") : t(l, "deadline.due_tomorrow"),
  });
  const section = (k: Kind, title: string, tone: Section["tone"]): Section => ({ title, tone, total: count(k), lines: listed.filter((i) => i.kind === k).map(line) });
  const sections: Section[] = [
    section("overdue", t(l, "deadline.section_overdue"), "overdue"),
    section("today", t(l, "deadline.section_today"), "today"),
    section("tomorrow", t(l, "deadline.section_tomorrow"), "soon"),
  ];
  const mail = renderEmail({
    locale: l,
    preheader: t(l, "email.deadline.preheader", { summary }),
    heading: t(l, "email.deadline.heading"),
    intro: [t(l, "email.deadline.intro", { name: p.name })],
    sections,
    more: p.items.length > listed.length ? t(l, "deadline.more", { n: p.items.length - listed.length }) : undefined,
    button: { label: t(l, "email.deadline.button"), url: myTasksLink(ctx.appUrl, orgId) },
    footer: [t(l, "email.deadline.footer")],
  });
  return { subject: t(l, "email.deadline.subject", { app, summary }), ...mail };
}
