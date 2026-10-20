import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { changeStatus, createTask, setAssignees, updateTask } from "@/data/tasks";
import { updateSettings } from "@/data/notifications";
import { digestLog, jobs, notifications, users } from "@/db/schema";
import { EmailError } from "@/integrations/email";
import { digestRun } from "@/jobs/handlers/digest";
import { remindersScan } from "@/jobs/handlers/reminders";
import type { JobRow } from "@/jobs/queue";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { clearOutbox, makeJobCtx, pump } from "./jobs-helpers";

const c = connect();
afterAll(() => c.close());

let O: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: O.org.id }, fn);
const notifsFor = (k: string, type?: string) => c.admin.select().from(notifications).where(and(eq(notifications.orgId, O.org.id), eq(notifications.userId, u[k]!.id))).then((r) => (type ? r.filter((n) => n.type === type) : r));
const job = {} as JobRow;

beforeAll(async () => {
  O = await makeOrg(c.admin, "ReminderOrg");
  for (const k of ["mgr", "bkk", "ny", "co"]) u[k] = await makeUser(c.admin, k);
  await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, u.bkk!.id));
  await c.admin.update(users).set({ timezone: "America/New_York", locale: "en" }).where(eq(users.id, u.ny!.id));
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, O.org.id, u.bkk!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.ny!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.co!.id, { role: "member" });
  await clearOutbox(c.admin);
});

const mk = (over: Partial<Parameters<typeof createTask>[1]>) => run("mgr", (s) => createTask(s, { projectId: O.project.id, title: "Reminder task", ...over }));

describe("due-soon reminders", () => {
  it("fire at 09:00 in the assignee's own time zone, once, no matter how often the scan runs", async () => {
    const t = await mk({ dueDate: "2026-07-11", reminderDaysBefore: 1, primaryAssigneeId: u.bkk!.id, coAssigneeIds: [u.ny!.id] });
    const { ctx, clock } = makeJobCtx(c.app);
    // 08:59 on 10 July in Bangkok = 01:59Z. Not yet for Bangkok; New York is still on 9 July (21:59 EDT) so not yet either.
    clock.now = new Date("2026-07-10T01:59:00Z");
    await remindersScan(ctx, job);
    expect(await notifsFor("bkk", "task.due_soon")).toHaveLength(0);
    // 09:00 Bangkok on 10 July = 02:00Z
    clock.now = new Date("2026-07-10T02:00:00Z");
    await remindersScan(ctx, job);
    await remindersScan(ctx, job); // a repeated run must not duplicate
    expect((await notifsFor("bkk", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(1);
    expect((await notifsFor("ny", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(0); // New York has not reached 09:00 on 10 July
    // 09:00 EDT on 10 July = 13:00Z
    clock.now = new Date("2026-07-10T13:00:00Z");
    await remindersScan(ctx, job);
    expect((await notifsFor("ny", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(1);
    expect((await notifsFor("bkk", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(1);
  });

  it("a missed scan is caught up later; a reminder is not sent after the due date has passed", async () => {
    const t = await mk({ dueDate: "2026-08-05", reminderDaysBefore: 2, primaryAssigneeId: u.bkk!.id });
    const { ctx, clock } = makeJobCtx(c.app);
    clock.now = new Date("2026-08-04T12:00:00Z"); // well after 09:00 on 3 Aug, scan never ran before
    await remindersScan(ctx, job);
    expect((await notifsFor("bkk", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(1);
    const late = await mk({ dueDate: "2026-08-05", reminderDaysBefore: 2, primaryAssigneeId: u.bkk!.id });
    clock.now = new Date("2026-08-06T05:00:00Z");
    await remindersScan(ctx, job);
    expect((await notifsFor("bkk", "task.due_soon")).filter((n) => n.taskId === late.id)).toHaveLength(0);
    expect((await notifsFor("bkk", "task.overdue")).filter((n) => n.taskId === late.id)).toHaveLength(1); // now it is overdue instead
  });

  it("changing the due date yields a fresh reminder for the new date; done and cancelled tasks never remind", async () => {
    const t = await mk({ dueDate: "2026-09-10", reminderDaysBefore: 0, primaryAssigneeId: u.bkk!.id });
    const { ctx, clock } = makeJobCtx(c.app);
    clock.now = new Date("2026-09-10T03:00:00Z");
    await remindersScan(ctx, job);
    expect((await notifsFor("bkk", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(1);
    await run("mgr", (s) => updateTask(s, t.id, { version: 1, dueDate: "2026-09-20" }));
    clock.now = new Date("2026-09-20T03:00:00Z");
    await remindersScan(ctx, job);
    expect((await notifsFor("bkk", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(2);

    const done = await mk({ dueDate: "2026-09-25", reminderDaysBefore: 0, primaryAssigneeId: u.bkk!.id });
    await run("bkk", async (s) => { await changeStatus(s, done.id, "progress"); await changeStatus(s, done.id, "done"); });
    clock.now = new Date("2026-09-25T03:00:00Z");
    await remindersScan(ctx, job);
    expect((await notifsFor("bkk")).filter((n) => n.taskId === done.id && ["task.due_soon", "task.overdue"].includes(n.type))).toHaveLength(0);
  });

  it("is DST-aware: the reminder instant tracks local 09:00 across the spring-forward weekend", async () => {
    const t = await mk({ dueDate: "2026-03-09", reminderDaysBefore: 1, primaryAssigneeId: u.ny!.id });
    const { ctx, clock } = makeJobCtx(c.app);
    clock.now = new Date("2026-03-08T12:59:00Z"); // 08:59 EDT (after the 02:00 jump): not yet
    await remindersScan(ctx, job);
    expect((await notifsFor("ny", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(0);
    clock.now = new Date("2026-03-08T13:00:00Z"); // 09:00 EDT
    await remindersScan(ctx, job);
    expect((await notifsFor("ny", "task.due_soon")).filter((n) => n.taskId === t.id)).toHaveLength(1);
  });

  it("tasks without an assignee or without a reminder setting are ignored", async () => {
    const a = await mk({ dueDate: "2026-10-10", reminderDaysBefore: 0 });
    const b = await mk({ dueDate: "2026-10-10", primaryAssigneeId: u.bkk!.id });
    const { ctx, clock } = makeJobCtx(c.app);
    clock.now = new Date("2026-10-10T03:00:00Z");
    await remindersScan(ctx, job);
    expect((await notifsFor("bkk")).filter((n) => [a.id, b.id].includes(n.taskId!) && n.type === "task.due_soon")).toHaveLength(0);
  });
});

describe("overdue alerts", () => {
  it("fire once per due date per assignee, using each person's local date", async () => {
    const t = await mk({ dueDate: "2026-11-10", primaryAssigneeId: u.bkk!.id, coAssigneeIds: [u.ny!.id] });
    const { ctx, clock } = makeJobCtx(c.app);
    clock.now = new Date("2026-11-10T20:00:00Z"); // 03:00 on the 11th in Bangkok (overdue), 15:00 on the 10th in New York (not yet)
    await remindersScan(ctx, job);
    expect((await notifsFor("bkk", "task.overdue")).filter((n) => n.taskId === t.id)).toHaveLength(1);
    expect((await notifsFor("ny", "task.overdue")).filter((n) => n.taskId === t.id)).toHaveLength(0);
    clock.now = new Date("2026-11-11T20:00:00Z");
    await remindersScan(ctx, job);
    await remindersScan(ctx, job);
    expect((await notifsFor("bkk", "task.overdue")).filter((n) => n.taskId === t.id)).toHaveLength(1);
    expect((await notifsFor("ny", "task.overdue")).filter((n) => n.taskId === t.id)).toHaveLength(1);
  });

  it("overdue and due-soon are in-app notifications; they are not e-mailed one task at a time (the daily deadline e-mail covers them)", async () => {
    const t = await mk({ dueDate: "2026-12-01", primaryAssigneeId: u.co!.id });
    const { ctx, clock, email } = makeJobCtx(c.app);
    clock.now = new Date("2026-12-03T05:00:00Z");
    await remindersScan(ctx, job);
    await pump(ctx, 1);
    const n = (await notifsFor("co", "task.overdue")).find((x) => x.taskId === t.id)!;
    expect(n.inApp).toBe(true);
    expect(n.emailWanted).toBe(false);
    expect(email.sent.some((m) => m.to.startsWith("co-") && m.text.includes(t.id) && /overdue|เลยกำหนด/.test(m.subject))).toBe(false); // (the e-mail about being assigned the task is a different one)
    expect(await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `email:${n.id}`))).toHaveLength(0);
  });
});

describe("digests", () => {

  it("sends one digest per period containing only what the user can still see, then never again for that period", async () => {
    const { ctx, clock, email } = makeJobCtx(c.app);
    const ctxU = { userId: u.co!.id, orgId: O.org.id };
    await withTenant(c.app, ctxU, (s) => updateSettings(s, { digest: "daily", settings: [{ channel: "email", event: "task.commented", enabled: false }] }));
    await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, u.co!.id));
    const t = await mk({ title: "Digest me", primaryAssigneeId: u.co!.id });
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.co!.id, co: [] })); // no-op change
    // make a notification that is NOT emailed individually (email off for comments) so it lands in the digest
    const { addComment } = await import("@/data/tasks");
    await run("mgr", (s) => addComment(s, t.id, { body: "ping" }));
    clock.now = new Date("2026-06-20T01:00:00Z"); // 08:00 Bangkok
    await pump(ctx, 1);
    const sentBefore = email.sent.length;
    await digestRun(ctx, job);
    const digest = email.sent.slice(sentBefore).find((m) => m.to.startsWith("co-"));
    expect(digest?.subject).toContain("daily");
    expect(digest?.text).toContain("Digest me");
    expect(digest?.idempotencyKey).toMatch(/^digest-/);
    await digestRun(ctx, job); // same period again
    expect(email.sent.slice(sentBefore).filter((m) => m.to.startsWith("co-"))).toHaveLength(1);
    expect((await c.admin.select().from(digestLog).where(eq(digestLog.userId, u.co!.id))).map((r) => r.periodKey)).toContain("daily:2026-06-20");
    // next day, nothing new => no email but the period is recorded
    clock.now = new Date("2026-06-21T01:00:00Z");
    const n = email.sent.length;
    await digestRun(ctx, job);
    expect(email.sent.length).toBe(n);
  });

  it("before the local send time a run serves yesterday's period once (so a once-a-day schedule reaches everyone), and never twice", async () => {
    const who = await makeUser(c.admin, "early");
    await addMember(c.admin, O.org.id, who.id, { role: "member" });
    await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, who.id));
    // e-mail off for assignments, so the notification is one the digest is for (an e-mailed one is left out)
    await withTenant(c.app, { userId: who.id, orgId: O.org.id }, (s) => updateSettings(s, { digest: "daily", settings: [{ channel: "email", event: "task.assigned", enabled: false }] }));
    const { ctx, clock, email } = makeJobCtx(c.app);
    const t = await mk({ title: "Early bird" });
    const { setAssignees: assign } = await import("@/data/tasks");
    await run("mgr", (s) => assign(s, t.id, { primary: who.id, co: [] }));
    await pump(ctx, 1); // the notification exists once the outbox has been processed
    const mine = () => email.sent.filter((m) => m.to.startsWith("early-"));
    clock.now = new Date("2026-06-22T00:30:00Z"); // 07:30 Bangkok on the 22nd: the latest send time that has passed is the 21st's
    await digestRun(ctx, job);
    expect(mine()).toHaveLength(1);
    expect(mine()[0]!.html).toContain("Early bird");
    expect((await c.admin.select().from(digestLog).where(eq(digestLog.userId, who.id))).map((r) => r.periodKey)).toEqual(["daily:2026-06-21"]);
    await digestRun(ctx, job); // the same period again
    expect(mine()).toHaveLength(1);
    clock.now = new Date("2026-06-22T01:30:00Z"); // 08:30: a new period, nothing new in it
    await digestRun(ctx, job);
    expect(mine()).toHaveLength(1);
  });

  it("leaves out what is e-mailed one by one (even if that e-mail is still waiting), and waits out quiet hours", async () => {
    const who = await makeUser(c.admin, "quietdigest");
    await addMember(c.admin, O.org.id, who.id, { role: "member" });
    await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, who.id));
    // e-mail stays ON for assignments: the notification is wanted by e-mail, so it belongs to that e-mail and not to the digest
    await withTenant(c.app, { userId: who.id, orgId: O.org.id }, (s) => updateSettings(s, { digest: "daily", quietStart: "22:00", quietEnd: "07:00" }));
    const { ctx, clock, email } = makeJobCtx(c.app);
    const t = await mk({ title: "Emailed on its own" });
    const { setAssignees: assign } = await import("@/data/tasks");
    await run("mgr", (s) => assign(s, t.id, { primary: who.id, co: [] }));
    await pump(ctx, 1);
    await c.admin.update(notifications).set({ emailedAt: null, digestedAt: null }).where(eq(notifications.userId, who.id)); // as if that e-mail were still waiting
    const mine = () => email.sent.filter((m) => m.to.startsWith("quietdigest-"));
    const before = mine().length; // (the individual e-mail of the assignment, sent by the pump)
    clock.now = new Date("2026-06-22T01:30:00Z"); // 08:30 Bangkok on the 22nd
    await digestRun(ctx, job);
    expect(mine()).toHaveLength(before); // its own e-mail is its channel; the digest does not repeat it

    // a notification with no individual e-mail does reach the digest, but not during quiet hours
    await withTenant(c.app, { userId: who.id, orgId: O.org.id }, (s) => updateSettings(s, { settings: [{ channel: "email", event: "task.commented", enabled: false }] }));
    const { addComment } = await import("@/data/tasks");
    await run("mgr", (s) => addComment(s, t.id, { body: "plain comment" }));
    await pump(ctx, 1);
    clock.now = new Date("2026-06-23T16:00:00Z"); // 23:00 Bangkok: inside quiet hours
    await digestRun(ctx, job);
    expect(mine()).toHaveLength(before);
    expect(await c.admin.select().from(digestLog).where(and(eq(digestLog.userId, who.id), eq(digestLog.periodKey, "daily:2026-06-23")))).toHaveLength(0); // the period was not used up
    clock.now = new Date("2026-06-24T01:00:00Z"); // 08:00 the next morning
    await digestRun(ctx, job);
    expect(mine()).toHaveLength(before + 1);
    const digest = mine().at(-1)!;
    expect(digest.idempotencyKey).toMatch(/^digest-/);
    expect(digest.html).toContain("commented");
    expect(digest.html).not.toContain("assigned you");
  });

  it("does not repeat in the digest what the deadline e-mail lists; keeps reminders set further ahead, and everything for someone who switched that e-mail off", async () => {
    const mkUser = async (name: string) => {
      const who = await makeUser(c.admin, name);
      await addMember(c.admin, O.org.id, who.id, { role: "member" });
      await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, who.id));
      return who;
    };
    const on = await mkUser("covon");
    const off = await mkUser("covoff");
    await withTenant(c.app, { userId: on.id, orgId: O.org.id }, (s) => updateSettings(s, { digest: "daily" }));
    await withTenant(c.app, { userId: off.id, orgId: O.org.id }, (s) => updateSettings(s, { digest: "daily", settings: [{ channel: "email", event: "task.due_soon", enabled: false }, { channel: "email", event: "task.overdue", enabled: false }] }));
    const today = await mk({ title: "CovToday", dueDate: "2026-07-06", reminderDaysBefore: 0, primaryAssigneeId: on.id, coAssigneeIds: [off.id] });
    const tomorrow = await mk({ title: "CovTomorrow", dueDate: "2026-07-07", reminderDaysBefore: 1, primaryAssigneeId: on.id, coAssigneeIds: [off.id] });
    const ahead = await mk({ title: "CovAhead", dueDate: "2026-07-09", reminderDaysBefore: 3, primaryAssigneeId: on.id, coAssigneeIds: [off.id] });
    const late = await mk({ title: "CovLate", dueDate: "2026-07-04", primaryAssigneeId: on.id, coAssigneeIds: [off.id] });
    const { ctx, clock, email } = makeJobCtx(c.app);
    clock.now = new Date("2026-07-06T03:00:00Z"); // 10:00 on the 6th in Bangkok
    await pump(ctx, 1);
    await remindersScan(ctx, job);
    const types = async (id: string) => (await c.admin.select().from(notifications).where(and(eq(notifications.orgId, O.org.id), eq(notifications.userId, id)))).map((n) => `${n.type}:${n.taskId}`);
    for (const id of [on.id, off.id]) expect(await types(id)).toEqual(expect.arrayContaining([`task.due_soon:${today.id}`, `task.due_soon:${tomorrow.id}`, `task.due_soon:${ahead.id}`, `task.overdue:${late.id}`]));

    await digestRun(ctx, job);
    const digestOf = (prefix: string) => email.sent.filter((m) => m.to.startsWith(prefix) && /digest/i.test(m.subject));
    // listed in the deadline e-mail (due today or tomorrow, overdue): not said twice; the reminder for a task due in three days is not in it
    expect(digestOf("covon-")).toHaveLength(1);
    const kept = digestOf("covon-")[0]!;
    expect(kept.html).toContain("CovAhead");
    expect(kept.html).not.toContain("CovToday");
    expect(kept.html).not.toContain("CovTomorrow");
    expect(kept.html).not.toContain("CovLate");
    // switched e-mail off for those kinds: the deadline e-mail will not list them, so the digest is where they appear
    expect(digestOf("covoff-")).toHaveLength(1);
    const all = digestOf("covoff-")[0]!;
    for (const title of ["CovAhead", "CovToday", "CovTomorrow", "CovLate"]) expect(all.html, title).toContain(title);
    // the button opens the person's own tasks, a page that exists
    expect(kept.html).toContain(`href="http://localhost:3000/o/${O.org.id}/my-tasks"`);
    expect(kept.text).toContain(`http://localhost:3000/o/${O.org.id}/my-tasks`);
  });

  it("between midnight and 09:00 a reminder is not dropped as 'covered' for a task the deadline e-mail does not list yet", async () => {
    const who = await makeUser(c.admin, "smallhours");
    await addMember(c.admin, O.org.id, who.id, { role: "member" });
    await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, who.id));
    await withTenant(c.app, { userId: who.id, orgId: O.org.id }, (s) => updateSettings(s, { digest: "daily" }));
    // due on the 8th, reminder 2 days before: it exists from 09:00 on the 6th
    await mk({ title: "SmallHoursTask", dueDate: "2026-07-08", reminderDaysBefore: 2, primaryAssigneeId: who.id });
    const { ctx, clock, email } = makeJobCtx(c.app);
    clock.now = new Date("2026-07-06T03:00:00Z"); // 10:00 on the 6th
    await pump(ctx, 1);
    await remindersScan(ctx, job);
    // 03:00 on the 7th: the calendar says the 8th is "tomorrow", but the deadline e-mail still judges by the period that began at 09:00 on the 6th,
    // for which the 8th is two days away and not listed. The digest must keep this reminder.
    clock.now = new Date("2026-07-06T20:00:00Z");
    await digestRun(ctx, job);
    const mine = email.sent.filter((m) => m.to === who.email && /digest/i.test(m.subject));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.html).toContain("SmallHoursTask");
  });

  it("a failed send rolls the period claim back so the next run retries; no duplicate after success", async () => {
    const who = await makeUser(c.admin, "retrier");
    await addMember(c.admin, O.org.id, who.id, { role: "member" });
    await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, who.id));
    await withTenant(c.app, { userId: who.id, orgId: O.org.id }, (s) => updateSettings(s, { digest: "daily", settings: [{ channel: "email", event: "task.assigned", enabled: false }] }));
    const { ctx, clock, email } = makeJobCtx(c.app);
    const t = await mk({ title: "Retry digest" });
    const { setAssignees: assign } = await import("@/data/tasks");
    await run("mgr", (s) => assign(s, t.id, { primary: who.id, co: [] }));
    clock.now = new Date("2026-06-23T02:00:00Z");
    await pump(ctx, 1);
    email.failNext = new EmailError("down", true);
    await expect(digestRun(ctx, job)).rejects.toThrow();
    expect(await c.admin.select().from(digestLog).where(eq(digestLog.userId, who.id))).toHaveLength(0);
    await digestRun(ctx, job);
    await digestRun(ctx, job);
    expect(email.sent.filter((m) => m.to.startsWith("retrier-") && m.text.includes("Retry digest"))).toHaveLength(1);
  });

  it("leaves out notifications for tasks the user has since lost access to", async () => {
    const who = await makeUser(c.admin, "lost");
    const m = await addMember(c.admin, O.org.id, who.id, { role: "member" });
    await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, who.id));
    await withTenant(c.app, { userId: who.id, orgId: O.org.id }, (s) => updateSettings(s, { digest: "daily", settings: [{ channel: "email", event: "task.assigned", enabled: false }] }));
    const { ctx, clock, email } = makeJobCtx(c.app);
    const t = await mk({ title: "Was visible" });
    const { setAssignees: assign } = await import("@/data/tasks");
    await run("mgr", (s) => assign(s, t.id, { primary: who.id, co: [] }));
    clock.now = new Date("2026-06-24T02:00:00Z");
    await pump(ctx, 1);
    // still an approved member, but every role (and so every project permission) is removed
    await c.admin.execute(`delete from role_assignments where membership_id = '${m.id}'` as never);
    await digestRun(ctx, job);
    expect(email.sent.filter((x) => x.to.startsWith("lost-"))).toHaveLength(0);
    expect((await c.admin.select().from(digestLog).where(eq(digestLog.userId, who.id))).map((r) => r.periodKey)).toContain("daily:2026-06-24"); // evaluated, just nothing visible to send
  });
});
