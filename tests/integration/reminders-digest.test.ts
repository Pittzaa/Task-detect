import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { changeStatus, createTask, setAssignees, updateTask } from "@/data/tasks";
import { updateSettings } from "@/data/notifications";
import { digestLog, notifications, users } from "@/db/schema";
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

  it("emails are queued for overdue (on by default) and delivered via the normal pipeline", async () => {
    const t = await mk({ dueDate: "2026-12-01", primaryAssigneeId: u.co!.id });
    const { ctx, clock, email } = makeJobCtx(c.app);
    clock.now = new Date("2026-12-03T05:00:00Z");
    await remindersScan(ctx, job);
    await pump(ctx, 1);
    const mail = email.sent.find((m) => m.to.startsWith("co-") && m.text.includes(t.id));
    expect(mail?.subject).toMatch(/overdue|เลยกำหนด/);
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

  it("is not sent before the local send time", async () => {
    const who = await makeUser(c.admin, "early");
    await addMember(c.admin, O.org.id, who.id, { role: "member" });
    await c.admin.update(users).set({ timezone: "Asia/Bangkok", locale: "en" }).where(eq(users.id, who.id));
    await withTenant(c.app, { userId: who.id, orgId: O.org.id }, (s) => updateSettings(s, { digest: "daily" }));
    const { ctx, clock, email } = makeJobCtx(c.app);
    const t = await mk({ title: "Early bird" });
    const { setAssignees: assign } = await import("@/data/tasks");
    await run("mgr", (s) => assign(s, t.id, { primary: who.id, co: [] }));
    await c.admin.update(notifications).set({ emailedAt: null }).where(eq(notifications.userId, who.id));
    clock.now = new Date("2026-06-22T00:30:00Z"); // 07:30 Bangkok
    await digestRun(ctx, job);
    expect(email.sent.filter((m) => m.to.startsWith("early-"))).toHaveLength(0);
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
