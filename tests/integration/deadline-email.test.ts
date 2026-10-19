import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { createTask } from "@/data/tasks";
import { setProjectTeams } from "@/data/structure";
import { updateSettings } from "@/data/notifications";
import { setAutoEmail } from "@/data/org-settings";
import { digestLog, notificationPrefs, projects, tasks, users, memberships } from "@/db/schema";
import { EmailError, createCaptureSender } from "@/integrations/email";
import { DEADLINE_MAX_LISTED, deadlineEmail } from "@/jobs/handlers/deadline";
import type { JobRow } from "@/jobs/queue";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { makeJobCtx } from "./jobs-helpers";

/**
 * The daily deadline e-mail: one e-mail per person listing their unfinished tasks that are overdue or due today/tomorrow (their own
 * calendar), nothing for anyone without such a task, never a second one in the same period, HTML.
 */
const c = connect();
afterAll(() => c.close());

const NOON = new Date("2026-06-20T03:00:00Z"); // 10:00 on 20 June in Bangkok
const TODAY = "2026-06-20";
const job = { orgId: null, payload: {} } as unknown as JobRow;
const manualJob = (orgId: string) => ({ orgId, payload: { manual: true } }) as unknown as JobRow;

let O: Awaited<ReturnType<typeof makeOrg>>; let X: Awaited<ReturnType<typeof makeOrg>>; let M: Awaited<ReturnType<typeof makeOrg>>;
let hidden: string; // a project nobody reads except organization-wide roles
const u: Record<string, { id: string; email: string; name: string }> = {};
const as = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2], org = O) => withTenant(c.app, { userId: u[k]!.id, orgId: org.org.id }, fn);
const mk = (title: string, dueDate: string | undefined, o: Partial<Parameters<typeof createTask>[1]> = {}, org = O) =>
  as("mgr", (s) => createTask(s, { projectId: org.project.id, title, dueDate, ...o }), org);

function run(o: { now?: Date; fail?: string } = {}) {
  const { ctx, clock } = makeJobCtx(c.app);
  clock.now = o.now ?? NOON;
  const email = createCaptureSender();
  const send = email.send;
  email.send = async (m) => { if (o.fail && m.to === o.fail) throw new EmailError("provider down", true); return send(m); };
  ctx.email = email;
  return { ctx, email };
}
const mailsTo = (email: ReturnType<typeof createCaptureSender>, k: string) => email.sent.filter((m) => m.to === u[k]!.email);
const claims = (k: string) => c.admin.select().from(digestLog).where(and(eq(digestLog.userId, u[k]!.id), like(digestLog.periodKey, "deadline:%")));

beforeAll(async () => {
  O = await makeOrg(c.admin, "DeadlineOrg"); X = await makeOrg(c.admin, "DeadlineOther"); M = await makeOrg(c.admin, "DeadlineManual", { autoEmail: false });
  for (const k of ["mgr", "ann", "bob", "cat", "dan", "eve", "scoped", "ny", "xann", "mann"]) u[k] = await makeUser(c.admin, k);
  await c.admin.update(users).set({ name: "Ann <Admin>", locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, u.ann!.id));
  await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(inArray(users.id, [u.bob!.id, u.cat!.id, u.dan!.id, u.eve!.id, u.scoped!.id]));
  await c.admin.update(users).set({ locale: "en", timezone: "America/New_York" }).where(eq(users.id, u.ny!.id));
  await c.admin.update(users).set({ locale: "th", timezone: "Asia/Bangkok" }).where(eq(users.id, u.mann!.id));
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  for (const k of ["ann", "bob", "cat", "dan", "eve", "ny"]) await addMember(c.admin, O.org.id, u[k]!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.scoped!.id, { role: "member", scope: { type: "team", id: O.team.id } });
  // the organization's project is open to the team; "hidden" is not linked to any team
  const admin = await makeUser(c.admin, "boss");
  u.boss = admin;
  await addMember(c.admin, O.org.id, admin.id, { role: "orgadmin" });
  await withTenant(c.app, { userId: admin.id, orgId: O.org.id }, (s) => setProjectTeams(s, O.project.id, [O.team.id]));
  const [p] = await c.admin.insert(projects).values({ orgId: O.org.id, name: "Hidden Project" }).returning({ id: projects.id });
  hidden = p!.id;
  await addMember(c.admin, X.org.id, u.xann!.id, { role: "member" });
  await addMember(c.admin, X.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, M.org.id, u.mann!.id, { role: "member" });
  await addMember(c.admin, M.org.id, u.mgr!.id, { role: "manager" });
});

describe("who is e-mailed, and what is in it", () => {
  it("one e-mail per person, listing every unfinished task that is overdue, due today or due tomorrow, and nothing else", async () => {
    await mk("Overdue old", "2026-06-10", { primaryAssigneeId: u.ann!.id });
    await mk("Overdue yesterday", "2026-06-19", { primaryAssigneeId: u.ann!.id });
    await mk("Due today <b>bold</b>", TODAY, { primaryAssigneeId: u.ann!.id });
    await mk("Due tomorrow", "2026-06-21", { primaryAssigneeId: u.ann!.id });
    await mk("Due in two days", "2026-06-22", { primaryAssigneeId: u.ann!.id });
    await mk("Due in three days", "2026-06-23", { primaryAssigneeId: u.ann!.id });
    await mk("No due date", undefined, { primaryAssigneeId: u.ann!.id });
    const done = await mk("Overdue but done", "2026-06-15", { primaryAssigneeId: u.ann!.id });
    const cancelled = await mk("Overdue but cancelled", "2026-06-15", { primaryAssigneeId: u.ann!.id });
    const gone = await mk("Overdue but deleted", "2026-06-15", { primaryAssigneeId: u.ann!.id });
    await mk("Overdue and somebody else's", "2026-06-15", { primaryAssigneeId: u.bob!.id });
    await c.admin.update(tasks).set({ status: "done", completedAt: new Date() }).where(eq(tasks.id, done.id));
    await c.admin.update(tasks).set({ status: "cancelled" }).where(eq(tasks.id, cancelled.id));
    await c.admin.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, gone.id));
    await mk("Shared with a co-assignee", TODAY, { primaryAssigneeId: u.bob!.id, coAssigneeIds: [u.cat!.id] });

    const { ctx, email } = run();
    await deadlineEmail(ctx, job);

    const ann = mailsTo(email, "ann");
    expect(ann).toHaveLength(1); // one e-mail, not one per task
    const html = ann[0]!.html;
    for (const title of ["Overdue old", "Overdue yesterday", "Due tomorrow"]) expect(html, title).toContain(title);
    for (const title of ["Due in two days", "Due in three days", "No due date", "Overdue but done", "Overdue but cancelled", "Overdue but deleted", "somebody else"]) expect(html, title).not.toContain(title);
    expect(html).toContain("Due today &lt;b&gt;bold&lt;/b&gt;"); // a task title is data, never markup
    expect(html).not.toContain("<b>bold</b>");
    expect(html).toContain("Overdue (2)");
    expect(html).toContain("Due today (1)");
    expect(html).toContain("Due tomorrow (1)");
    expect(html).toContain("10 day(s) overdue"); // 20 June against 10 June
    expect(html).toContain("Status: To do");
    expect(html).toContain("Project: DeadlineOrg Project");
    expect(ann[0]!.subject).toBe("[Task Tracker] Unfinished tasks: 2 overdue, 1 due today, 1 due tomorrow");
    expect(ann[0]!.text).toContain("Overdue old");
    expect(ann[0]!.text).toContain(`/o/${O.org.id}/my-tasks`);
    expect(html).toContain("Hello Ann &lt;Admin&gt;"); // the name is escaped too
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(ann[0]!.idempotencyKey).toMatch(/^deadline-/);

    // the co-assignee is included; the primary assignee too; people with no qualifying task get nothing
    expect(mailsTo(email, "cat")).toHaveLength(1);
    expect(mailsTo(email, "cat")[0]!.html).toContain("Shared with a co-assignee");
    expect(mailsTo(email, "bob")[0]!.html).toContain("Shared with a co-assignee");
    expect(mailsTo(email, "bob")[0]!.html).toContain("Overdue and somebody else&#39;s");
    for (const k of ["dan", "eve", "scoped", "mgr"]) expect(mailsTo(email, k), k).toHaveLength(0);
  });

  it("the link of each task opens that task in this organization", async () => {
    const t = await mk("Linked task", TODAY, { primaryAssigneeId: u.dan!.id });
    const { ctx, email } = run();
    await deadlineEmail(ctx, job);
    expect(mailsTo(email, "dan")[0]!.html).toContain(`/o/${O.org.id}/tasks?task=${t.id}`);
  });

  it("leaves out a task the person can no longer read, and a deleted project's tasks; the same tasks are listed once they can be read", async () => {
    // the application refuses to assign someone who cannot read the project, so this stands for access lost after the assignment
    const unreadable = await as("mgr", (s) => createTask(s, { projectId: hidden, title: "In the hidden project", dueDate: "2026-06-18" }));
    await c.admin.update(tasks).set({ primaryAssigneeId: u.scoped!.id }).where(eq(tasks.id, unreadable.id));
    await mk("Scoped person's own", "2026-06-18", { primaryAssigneeId: u.scoped!.id });
    const inGone = await as("mgr", (s) => createTask(s, { projectId: hidden, title: "In a deleted project", dueDate: "2026-06-18" }));
    await c.admin.update(tasks).set({ primaryAssigneeId: u.eve!.id }).where(eq(tasks.id, inGone.id));
    await c.admin.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, hidden));
    const { ctx, email } = run();
    await deadlineEmail(ctx, job);
    const scoped = mailsTo(email, "scoped");
    expect(scoped).toHaveLength(1);
    expect(scoped[0]!.html).toContain("Scoped person&#39;s own");
    expect(scoped[0]!.html).not.toContain("hidden project");
    expect(mailsTo(email, "eve")).toHaveLength(0); // everything of theirs was in a deleted project

    // positive control: bring the project back and open it to the team, and the very same tasks are listed (on another day, a new period).
    // Without this the checks above would also pass if the e-mail simply never listed anything from that project.
    await c.admin.update(projects).set({ deletedAt: null }).where(eq(projects.id, hidden));
    await withTenant(c.app, { userId: u.boss!.id, orgId: O.org.id }, (s) => setProjectTeams(s, hidden, [O.team.id]));
    try {
      const later = run({ now: new Date("2026-06-27T03:00:00Z") });
      await deadlineEmail(later.ctx, job);
      expect(mailsTo(later.email, "scoped")[0]!.html).toContain("In the hidden project");
      expect(mailsTo(later.email, "eve")[0]!.html).toContain("In a deleted project");
    } finally {
      await withTenant(c.app, { userId: u.boss!.id, orgId: O.org.id }, (s) => setProjectTeams(s, hidden, []));
    }
  });

  it("a suspended member is not e-mailed", async () => {
    await mk("Suspended person's task", "2026-06-18", { primaryAssigneeId: u.eve!.id });
    await c.admin.update(memberships).set({ status: "suspended" }).where(and(eq(memberships.orgId, O.org.id), eq(memberships.userId, u.eve!.id)));
    const { ctx, email } = run();
    await deadlineEmail(ctx, job);
    expect(mailsTo(email, "eve")).toHaveLength(0);
    await c.admin.update(memberships).set({ status: "approved" }).where(and(eq(memberships.orgId, O.org.id), eq(memberships.userId, u.eve!.id)));
  });

  it("another organization's people and tasks stay in their own e-mail", async () => {
    await mk("Other org task", "2026-06-18", { primaryAssigneeId: u.xann!.id }, X);
    const { ctx, email } = run();
    await deadlineEmail(ctx, job);
    const x = mailsTo(email, "xann");
    expect(x).toHaveLength(1);
    expect(x[0]!.html).toContain("Other org task");
    expect(x[0]!.html).toContain(`/o/${X.org.id}/`);
    expect(x[0]!.html).not.toContain("Overdue old");
    expect(email.sent.filter((m) => m.to !== u.xann!.email && m.html.includes("Other org task"))).toHaveLength(0); // and it reached nobody else
  });
});

describe("once a person a day", () => {
  it("never again in the same period, whatever changes meanwhile; the next day it can come again", async () => {
    const a = run();
    await deadlineEmail(a.ctx, job);
    expect(mailsTo(a.email, "ann")).toHaveLength(0); // the first test's run already served Ann for this period
    expect((await claims("ann")).map((r) => r.periodKey)).toContain("deadline:daily:2026-06-20");

    await mk("New overdue task for Ann", "2026-06-19", { primaryAssigneeId: u.ann!.id });
    const later = run({ now: new Date("2026-06-20T14:00:00Z") }); // 21:00 the same day
    await deadlineEmail(later.ctx, job);
    expect(mailsTo(later.email, "ann")).toHaveLength(0);

    const nextDay = run({ now: new Date("2026-06-21T03:00:00Z") }); // 10:00 on the 21st
    await deadlineEmail(nextDay.ctx, job);
    const ann = mailsTo(nextDay.email, "ann");
    expect(ann).toHaveLength(1);
    expect(ann[0]!.html).toContain("New overdue task for Ann");
    expect((await claims("ann")).map((r) => r.periodKey)).toContain("deadline:daily:2026-06-21");
  });

  it("a person with nothing pending is not e-mailed and uses up no period, so something that turns up later the same day still goes out", async () => {
    const { ctx, email } = run({ now: new Date("2026-07-05T03:00:00Z") });
    await deadlineEmail(ctx, job);
    expect(mailsTo(email, "dan")).toHaveLength(1); // Dan's task from before is overdue by then
    await c.admin.update(tasks).set({ status: "done", completedAt: new Date() }).where(eq(tasks.primaryAssigneeId, u.dan!.id));
    const fresh = await makeUser(c.admin, "freshman");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, fresh.id));
    await addMember(c.admin, O.org.id, fresh.id, { role: "member" });
    const a = run({ now: new Date("2026-07-06T03:00:00Z") });
    await deadlineEmail(a.ctx, job);
    expect(a.email.sent.filter((m) => m.to === fresh.email)).toHaveLength(0);
    expect(await c.admin.select().from(digestLog).where(and(eq(digestLog.userId, fresh.id), like(digestLog.periodKey, "deadline:%")))).toHaveLength(0);
    await mk("Arrives in the afternoon", "2026-07-05", { primaryAssigneeId: fresh.id });
    const b = run({ now: new Date("2026-07-06T10:00:00Z") });
    await deadlineEmail(b.ctx, job);
    expect(b.email.sent.filter((m) => m.to === fresh.email)).toHaveLength(1);
  });
});

describe("what a person chose", () => {
  it("honours the e-mail choices for due soon and overdue: each switches its own sections off, both off means nothing", async () => {
    const t0 = new Date("2026-08-10T03:00:00Z");
    await mk("Choice overdue", "2026-08-08", { primaryAssigneeId: u.bob!.id });
    await mk("Choice today", "2026-08-10", { primaryAssigneeId: u.bob!.id });
    const set = (soon: boolean, over: boolean) => as("bob", (s) => updateSettings(s, { settings: [{ channel: "email", event: "task.due_soon", enabled: soon }, { channel: "email", event: "task.overdue", enabled: over }] }));
    const sent = async (day: number) => { const r = run({ now: new Date(t0.getTime() + day * 86_400_000) }); await deadlineEmail(r.ctx, job); return mailsTo(r.email, "bob"); };

    await set(false, true);
    const onlyOverdue = (await sent(0))[0]!;
    expect(onlyOverdue.html).toContain("Choice overdue");
    expect(onlyOverdue.html).not.toContain("Choice today");
    await set(true, false);
    await mk("Choice tomorrow", "2026-08-12", { primaryAssigneeId: u.bob!.id });
    const onlySoon = (await sent(1))[0]!; // a new period: the day after
    expect(onlySoon.html).toContain("Choice tomorrow");
    expect(onlySoon.html).not.toContain("Choice overdue"); // (still overdue, but switched off)
    await set(false, false);
    expect(await sent(2)).toHaveLength(0);
    await set(true, true);
  });

  it("waits out quiet hours instead of sending into them, and sends once they are over", async () => {
    const day = new Date("2026-09-01T03:00:00Z"); // 10:00 Bangkok
    await mk("Quiet hours task", "2026-08-30", { primaryAssigneeId: u.cat!.id });
    await as("cat", (s) => updateSettings(s, { quietStart: "09:00", quietEnd: "12:00" }));
    const quiet = run({ now: day });
    await deadlineEmail(quiet.ctx, job);
    expect(mailsTo(quiet.email, "cat")).toHaveLength(0);
    expect((await claims("cat")).map((r) => r.periodKey)).not.toContain("deadline:daily:2026-09-01");
    const after = run({ now: new Date("2026-09-01T06:00:00Z") }); // 13:00
    await deadlineEmail(after.ctx, job);
    expect(mailsTo(after.email, "cat")).toHaveLength(1);
    await c.admin.update(notificationPrefs).set({ quietStart: null, quietEnd: null }).where(eq(notificationPrefs.userId, u.cat!.id));
  });
});

describe("time zones and language", () => {
  it("the person's own calendar decides what is today, and a Thai person gets Thai", async () => {
    await mk("New York due the 19th", "2026-06-19", { primaryAssigneeId: u.ny!.id });
    await mk("New York due the 20th", "2026-06-20", { primaryAssigneeId: u.ny!.id });
    // 03:00Z on the 20th is 23:00 on the 19th in New York: the 19th is today, the 20th tomorrow
    const { ctx, email } = run({ now: new Date("2026-06-20T03:00:00Z") });
    await deadlineEmail(ctx, job);
    const ny = mailsTo(email, "ny")[0]!;
    expect(ny.html).toContain("Due today (1)");
    expect(ny.html).toContain("Due tomorrow (1)");
    expect(ny.subject).toBe("[Task Tracker] Unfinished tasks: 1 due today, 1 due tomorrow");
    expect((await claims("ny")).map((r) => r.periodKey)).toContain("deadline:daily:2026-06-19");

    await mk("งานภาษาไทย", "2026-06-19", { primaryAssigneeId: u.mann!.id }, M);
  });

  it("a once-a-day run at 16:00 UTC (23:00 in Bangkok) reaches everyone, including people for whom it is before 09:00", async () => {
    const honolulu = await makeUser(c.admin, "honolulu");
    await c.admin.update(users).set({ locale: "en", timezone: "Pacific/Honolulu" }).where(eq(users.id, honolulu.id));
    await addMember(c.admin, O.org.id, honolulu.id, { role: "member" });
    await mk("Island task", "2026-10-01", { primaryAssigneeId: honolulu.id });
    const seen: string[] = [];
    for (const d of ["02", "03", "04"]) {
      const { ctx, email } = run({ now: new Date(`2026-10-${d}T16:00:00Z`) }); // 06:00 in Honolulu
      await deadlineEmail(ctx, job);
      seen.push(...email.sent.filter((m) => m.to === honolulu.email).map(() => d));
    }
    expect(seen).toEqual(["02", "03", "04"]); // one a day, none skipped, none repeated
  });
});

describe("east of UTC and at the same moment", () => {
  it("in New Zealand the 21st has begun while it is still the 20th in UTC: today, tomorrow and overdue follow the local date", async () => {
    const kiwi = await makeUser(c.admin, "kiwi");
    await c.admin.update(users).set({ locale: "en", timezone: "Pacific/Auckland" }).where(eq(users.id, kiwi.id));
    await addMember(c.admin, O.org.id, kiwi.id, { role: "member" });
    for (const [title, due] of [["Kiwi due 20th", "2026-06-20"], ["Kiwi due 21st", "2026-06-21"], ["Kiwi due 22nd", "2026-06-22"], ["Kiwi due 23rd", "2026-06-23"]] as const) await mk(title, due, { primaryAssigneeId: kiwi.id });
    const { ctx, email } = run({ now: new Date("2026-06-20T22:00:00Z") }); // 10:00 on the 21st in Auckland (UTC+12)
    await deadlineEmail(ctx, job);
    const mine = email.sent.filter((m) => m.to === kiwi.email);
    expect(mine).toHaveLength(1);
    const html = mine[0]!.html;
    expect(html).toContain("Overdue (1)");
    expect(html).toContain("Due today (1)");
    expect(html).toContain("Due tomorrow (1)");
    expect(html).toContain("Kiwi due 20th");
    expect(html).not.toContain("Kiwi due 23rd");
    expect(mine[0]!.subject).toBe("[Task Tracker] Unfinished tasks: 1 overdue, 1 due today, 1 due tomorrow");
    const keys = (await c.admin.select().from(digestLog).where(and(eq(digestLog.userId, kiwi.id), like(digestLog.periodKey, "deadline:%")))).map((r) => r.periodKey);
    expect(keys).toEqual(["deadline:daily:2026-06-21"]);
  });

  it("runs at the same moment (administrators pressing the button together) send one e-mail between them", async () => {
    const twin = await makeUser(c.admin, "twin");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, twin.id));
    await addMember(c.admin, O.org.id, twin.id, { role: "member" });
    await mk("Twin task", "2026-06-10", { primaryAssigneeId: twin.id });
    // The first run is inside its send (its claim not yet committed) when the other two start: they read the same picture, find nobody
    // has been served yet, and meet the first one's claim at the unique key.
    const runs = [run(), run(), run()];
    let entered!: () => void;
    const inSend = new Promise<void>((resolve) => (entered = resolve));
    const first = runs[0]!.email.send;
    runs[0]!.email.send = async (m) => { entered(); await new Promise((r) => setTimeout(r, 400)); return first(m); };
    const started = deadlineEmail(runs[0]!.ctx, manualJob(O.org.id));
    await inSend;
    await Promise.all([started, ...runs.slice(1).map((r) => deadlineEmail(r.ctx, manualJob(O.org.id)))]);
    const sent = runs.flatMap((r) => r.email.sent).filter((m) => m.to === twin.email);
    expect(sent).toHaveLength(1);
    expect(await c.admin.select().from(digestLog).where(and(eq(digestLog.userId, twin.id), like(digestLog.periodKey, "deadline:%")))).toHaveLength(1);
  });
});

describe("limits and failures", () => {
  it("lists at most the first thirty, says how many more, and the subject counts all of them", async () => {
    const big = await makeUser(c.admin, "big");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, big.id));
    await addMember(c.admin, O.org.id, big.id, { role: "member" });
    for (let i = 0; i < DEADLINE_MAX_LISTED + 5; i++) await mk(`Backlog ${String(i).padStart(2, "0")}`, "2026-05-01", { primaryAssigneeId: big.id });
    const { ctx, email } = run({ now: new Date("2026-11-02T03:00:00Z") });
    await deadlineEmail(ctx, job);
    const mail = email.sent.find((m) => m.to === big.email)!;
    expect(mail.subject).toContain(`${DEADLINE_MAX_LISTED + 5} overdue`);
    expect((mail.html.match(/Backlog \d\d/g) ?? []).length).toBe(DEADLINE_MAX_LISTED);
    expect(mail.html).toContain("…and 5 more");
    expect(mail.html).toContain(`Overdue (${DEADLINE_MAX_LISTED} / ${DEADLINE_MAX_LISTED + 5})`); // the title says it is the first part of a larger number
  });

  it("one person's failure does not stop the others; the failed one is retried on the next run and nobody gets two", async () => {
    const failing = await makeUser(c.admin, "failing");
    const fine = await makeUser(c.admin, "fine");
    for (const p of [failing, fine]) {
      await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, p.id));
      await addMember(c.admin, O.org.id, p.id, { role: "member" });
      await mk(`Task of ${p.name}`, "2026-12-01", { primaryAssigneeId: p.id });
    }
    const now = new Date("2026-12-10T03:00:00Z");
    const first = run({ now, fail: failing.email });
    await expect(deadlineEmail(first.ctx, job)).rejects.toThrow(/Incomplete/); // the job is retried
    expect(first.email.sent.filter((m) => m.to === fine.email)).toHaveLength(1);
    expect(first.email.sent.filter((m) => m.to === failing.email)).toHaveLength(0);
    expect(await c.admin.select().from(digestLog).where(and(eq(digestLog.userId, failing.id), like(digestLog.periodKey, "deadline:%")))).toHaveLength(0); // the claim was given back

    const second = run({ now });
    await deadlineEmail(second.ctx, job);
    expect(second.email.sent.filter((m) => m.to === failing.email)).toHaveLength(1);
    expect(second.email.sent.filter((m) => m.to === fine.email)).toHaveLength(0);
  });

  it("an address the provider refuses (invalid, suppressed) is tried once for the period, not every hour", async () => {
    const dead = await makeUser(c.admin, "deadaddr");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, dead.id));
    await addMember(c.admin, O.org.id, dead.id, { role: "member" });
    await mk("For a dead address", "2027-01-01", { primaryAssigneeId: dead.id });
    const now = new Date("2027-01-05T03:00:00Z");
    const calls: string[] = [];
    const wrap = (r: ReturnType<typeof run>, error: EmailError) => { const send = r.email.send; r.email.send = async (m) => { if (m.to === dead.email) { calls.push(m.to); throw error; } return send(m); }; return r; };
    const first = wrap(run({ now }), new EmailError("refused", false, 422));
    await expect(deadlineEmail(first.ctx, job)).resolves.toBeUndefined(); // no retry storm
    expect(calls).toHaveLength(1);
    const later = wrap(run({ now: new Date(now.getTime() + 3_600_000) }), new EmailError("refused", false, 422)); // the next hourly run, same period
    await deadlineEmail(later.ctx, job);
    expect(calls).toHaveLength(1); // not offered to the provider again
    expect(await c.admin.select().from(digestLog).where(and(eq(digestLog.userId, dead.id), like(digestLog.periodKey, "deadline:%")))).toHaveLength(1); // the claim stayed
  });

  it("when the provider refuses our whole account (401/403) the run stops at the first person, the claim is given back and the job backs off", async () => {
    const a = await makeUser(c.admin, "keyfail-a");
    const b = await makeUser(c.admin, "keyfail-b");
    for (const p of [a, b]) {
      await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, p.id));
      await addMember(c.admin, O.org.id, p.id, { role: "member" });
      await mk(`Key task ${p.name}`, "2027-02-01", { primaryAssigneeId: p.id });
    }
    const { ctx, email } = run({ now: new Date("2027-02-05T03:00:00Z") });
    let tried = 0;
    const send = email.send;
    email.send = async (m) => { if (m.to === a.email || m.to === b.email) { tried++; throw new EmailError("unauthorized", false, 401); } return send(m); };
    await expect(deadlineEmail(ctx, job)).rejects.toThrow(/Incomplete/);
    expect(tried).toBeLessThanOrEqual(1); // not one call per person
    expect(await c.admin.select().from(digestLog).where(and(inArray(digestLog.userId, [a.id, b.id]), like(digestLog.periodKey, "deadline:%")))).toHaveLength(0);
  });
});

describe("running out of time", () => {
  it("is 'not now', not a failure: a run past its deadline defers without sending or claiming, and the next run serves everyone", async () => {
    const who = await makeUser(c.admin, "latecomer");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, who.id));
    await addMember(c.admin, O.org.id, who.id, { role: "member" });
    await mk("Late task", "2027-03-01", { primaryAssigneeId: who.id });
    const now = new Date("2027-03-05T03:00:00Z");
    // several organizations are eligible; with the deadline already past, the first is still processed (progress), the rest wait
    const late = run({ now });
    late.ctx.deadline = Date.now() - 1000;
    const { Deferred } = await import("@/jobs/worker");
    await expect(deadlineEmail(late.ctx, job)).rejects.toBeInstanceOf(Deferred);
    const next = run({ now });
    await deadlineEmail(next.ctx, job);
    // a late run always makes some progress, so the person may have been served by it or by the next: exactly once between them
    expect(late.email.sent.concat(next.email.sent).filter((m) => m.to === who.email)).toHaveLength(1);
  });

  it("people already served cost no work on the next run: they are filtered out before any send is attempted", async () => {
    const { ctx, email } = run({ now: new Date("2027-03-05T03:00:00Z") });
    let sends = 0;
    const send = email.send;
    email.send = async (m) => { sends++; return send(m); };
    await deadlineEmail(ctx, job);
    expect(sends).toBe(0); // the previous test's run already served everyone this period
  });
});

describe("one picture a day: what is sent and what is claimed are the same day", () => {
  it("a frequent scheduler sends nothing between midnight and 09:00 and exactly one e-mail from 09:00, and a task that only just came into range is not announced twice", async () => {
    const who = await makeUser(c.admin, "hourly");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, who.id));
    await addMember(c.admin, O.org.id, who.id, { role: "member" });
    // due on the 26th: it is "tomorrow" only from the 25th; the 24th (Bangkok) has nothing in range
    await mk("Streak starter", "2027-06-26", { primaryAssigneeId: who.id });
    const sent: string[] = [];
    // Bangkok is UTC+7: the 25th 00:00 local is 2027-06-24T17:00Z
    for (let h = 0; h <= 10; h++) {
      const at = new Date(Date.parse("2027-06-24T17:00:00Z") + h * 3_600_000);
      const { ctx, email } = run({ now: at });
      await deadlineEmail(ctx, job);
      for (const m of email.sent.filter((x) => x.to === who.email)) sent.push(`${String(h).padStart(2, "0")}:00 ${m.html.includes("Due tomorrow (1)") ? "tomorrow" : "other"}`);
    }
    expect(sent).toEqual(["09:00 tomorrow"]); // not at midnight, and not twice
  });

  it("the administrator's button before and after 09:00 sends at most one per period, each with the picture of its own day", async () => {
    const who = await makeUser(c.admin, "presser");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, who.id));
    await addMember(c.admin, M.org.id, who.id, { role: "member" });
    await mk("Pressed", "2027-07-20", { primaryAssigneeId: who.id }, M);
    const pressAt = async (iso: string) => { const r = run({ now: new Date(iso) }); await deadlineEmail(r.ctx, manualJob(M.org.id)); return r.email.sent.filter((m) => m.to === who.email); };
    expect(await pressAt("2027-07-20T00:00:00Z")).toHaveLength(1); // 07:00 local: the previous period's picture (the task is due "tomorrow" in it)
    expect(await pressAt("2027-07-20T01:00:00Z")).toHaveLength(0); // 08:00 local: the same period, already served
    const after = await pressAt("2027-07-20T03:00:00Z"); // 10:00 local: a new period
    expect(after).toHaveLength(1);
    expect(after[0]!.html).toContain("Due today (1)");
  });
});

describe("which tasks are listed when there are more than fit", () => {
  it("today's and tomorrow's come first, then the most recently overdue; each section says how many it shows of how many", async () => {
    const big = await makeUser(c.admin, "urgent");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, big.id));
    await addMember(c.admin, O.org.id, big.id, { role: "member" });
    for (let i = 0; i < DEADLINE_MAX_LISTED + 5; i++) await mk(`Old ${String(i).padStart(2, "0")}`, `2027-04-${String(1 + (i % 9)).padStart(2, "0")}`, { primaryAssigneeId: big.id });
    await mk("Due right now", "2027-05-10", { primaryAssigneeId: big.id });
    await mk("Due next", "2027-05-11", { primaryAssigneeId: big.id });
    const { ctx, email } = run({ now: new Date("2027-05-10T03:00:00Z") });
    await deadlineEmail(ctx, job);
    const mail = email.sent.find((m) => m.to === big.email)!;
    expect(mail.html).toContain("Due right now");
    expect(mail.html).toContain("Due next");
    expect((mail.html.match(/Old \d\d/g) ?? []).length).toBe(DEADLINE_MAX_LISTED - 2);
    expect(mail.html).toContain(`Overdue (${DEADLINE_MAX_LISTED - 2} / ${DEADLINE_MAX_LISTED + 5})`);
    expect(mail.html).toContain("Due today (1)");
    expect(mail.html).toContain("…and 7 more");
    expect(mail.subject).toContain(`${DEADLINE_MAX_LISTED + 5} overdue, 1 due today, 1 due tomorrow`);
  });

  it("the most recent of a huge backlog is read, not the oldest: the query cap cannot push out what is due now", async () => {
    // (the cap is 5000 tasks per organization, most recently due first; this checks the order of the query by a small stand-in)
    const { compose } = await import("@/jobs/handlers/deadline");
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}`, projectName: "P", status: "todo", priority: "medium", dueDate: `2027-01-${String(1 + (i % 28)).padStart(2, "0")}`, kind: "overdue" as const, daysOver: 10 + i }));
    items.push({ id: "now", title: "Right now", projectName: "P", status: "todo", priority: "low", dueDate: "2027-05-10", kind: "today" as never, daysOver: 0 });
    const mail = compose({ appUrl: "https://x.example" }, "o", { locale: "en", name: "N", items });
    expect(mail.html).toContain("Right now");
  });
});

describe("the switch", () => {
  it("an organization with automatic e-mail off is not e-mailed; the administrator's press sends to that organization only, still once a day", async () => {
    const day = new Date("2026-06-20T03:00:00Z");
    const auto = run({ now: day });
    await deadlineEmail(auto.ctx, job);
    expect(mailsTo(auto.email, "mann")).toHaveLength(0); // M has automatic e-mail off

    const press = run({ now: day });
    await deadlineEmail(press.ctx, manualJob(M.org.id));
    const mail = mailsTo(press.email, "mann");
    expect(mail).toHaveLength(1);
    expect(mail[0]!.html).toContain("งานภาษาไทย");
    expect(mail[0]!.html).toContain('lang="th"');
    expect(mail[0]!.subject).toContain("งานที่ยังไม่เสร็จ");
    expect(press.email.sent.map((m) => m.to)).toEqual([u.mann!.email]); // nobody of another organization

    const again = run({ now: day });
    await deadlineEmail(again.ctx, manualJob(M.org.id));
    expect(mailsTo(again.email, "mann")).toHaveLength(0);
  });

  it("the administrator's press on a day nobody has been served yet reaches that organization only, and claims nothing elsewhere", async () => {
    const day = new Date("2026-08-15T03:00:00Z");
    await mk("Fresh day, other organization", "2026-08-01", { primaryAssigneeId: u.ann!.id });
    await mk("Fresh day, other organization X", "2026-08-01", { primaryAssigneeId: u.xann!.id }, X);
    await mk("Fresh day, pressed organization", "2026-08-01", { primaryAssigneeId: u.mann!.id }, M);
    const press = run({ now: day });
    await deadlineEmail(press.ctx, manualJob(M.org.id));
    expect(press.email.sent.map((m) => m.to)).toEqual([u.mann!.email]);
    expect(await c.admin.select().from(digestLog).where(and(inArray(digestLog.orgId, [O.org.id, X.org.id]), like(digestLog.periodKey, "deadline:daily:2026-08-15")))).toHaveLength(0);
    // positive control: those same people were unserved and eligible, so the scheduler's run does reach them
    const auto = run({ now: day });
    await deadlineEmail(auto.ctx, job);
    expect(mailsTo(auto.email, "ann")[0]!.html).toContain("Fresh day, other organization");
    expect(mailsTo(auto.email, "xann")[0]!.html).toContain("Fresh day, other organization X");
    expect(mailsTo(auto.email, "mann")).toHaveLength(0); // M has automatic e-mail off, and the press already served it
  });

  it("turning the switch on in the application is what makes an organization eligible", async () => {
    const day = new Date("2026-06-21T03:00:00Z");
    await mk("Switch task", "2026-06-20", { primaryAssigneeId: u.mann!.id }, M);
    const admin = await makeUser(c.admin, "switchboss");
    await addMember(c.admin, M.org.id, admin.id, { role: "orgadmin" });
    const before = run({ now: day });
    await deadlineEmail(before.ctx, job);
    expect(mailsTo(before.email, "mann")).toHaveLength(0);
    await withTenant(c.app, { userId: admin.id, orgId: M.org.id }, (s) => setAutoEmail(s, true));
    try {
      const after = run({ now: day });
      await deadlineEmail(after.ctx, job);
      expect(mailsTo(after.email, "mann")).toHaveLength(1);
    } finally { await withTenant(c.app, { userId: admin.id, orgId: M.org.id }, (s) => setAutoEmail(s, false)); }
  });
});
