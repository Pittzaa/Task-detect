import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { setProjectTeams } from "@/data/structure";
import { addComment, changeStatus, createTask, deleteTask, setAssignees, updateTask, addDependency } from "@/data/tasks";
import { getSettings, listNotifications, markRead, unreadCount, updateSettings } from "@/data/notifications";
import { AppError } from "@/lib/errors";
import { deliveryAttempts, jobs, memberships, notificationPrefs, notifications, outboxEvents, users } from "@/db/schema";
import { EmailError } from "@/integrations/email";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { clearOutbox, makeJobCtx, pump, resetEvent } from "./jobs-helpers";

const c = connect();
afterAll(() => c.close());
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };

let O: Awaited<ReturnType<typeof makeOrg>>; let X: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: O.org.id }, fn);
const mkTask = (k = "mgr", over: Partial<Parameters<typeof createTask>[1]> = {}) => run(k, (s) => createTask(s, { projectId: O.project.id, title: "Task " + Math.random().toString(36).slice(2, 6), ...over }));
const notifs = (userKey: string) => c.admin.select().from(notifications).where(and(eq(notifications.orgId, O.org.id), eq(notifications.userId, u[userKey]!.id)));

beforeAll(async () => {
  O = await makeOrg(c.admin, "NotifOrg"); X = await makeOrg(c.admin, "NotifOther");
  for (const k of ["admin", "mgr", "mem1", "mem2", "view", "teamMem", "outsider", "xadmin"]) u[k] = await makeUser(c.admin, k);
  await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, u.mem1!.id));
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, O.org.id, u.mem1!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.mem2!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.view!.id, { role: "viewer" });
  await addMember(c.admin, O.org.id, u.teamMem!.id, { role: "member", scope: { type: "team", id: O.team.id } });
  await addMember(c.admin, O.org.id, u.outsider!.id, {});
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
  await run("admin", (s) => setProjectTeams(s, O.project.id, [O.team.id]));
  await clearOutbox(c.admin);
});

describe("assignment notifications", () => {
  it("notifies the assignee in-app and by email, in their language, and not the actor", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("mgr", { title: "Prepare launch" });
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [u.mem2!.id] }));
    await pump(ctx);
    expect((await notifs("mem1")).map((n) => n.type)).toContain("task.assigned");
    expect(await notifs("mgr")).toHaveLength(0); // the actor is never notified of their own action
    const mail = email.sent.find((m) => m.to.startsWith("mem1-"))!;
    expect(mail.subject).toContain('assigned you to "Prepare launch"'); // mem1 prefers English
    expect(mail.text).toContain(`/o/${O.org.id}/tasks?task=${t.id}`);
    const thMail = email.sent.find((m) => m.to.startsWith("mem2-"))!; // mem2 defaults to Thai
    expect(thMail.subject).toMatch(/[฀-๿]/);
    expect(thMail.subject).toContain("Prepare launch");
  });

  it("is idempotent: reprocessing the same event creates no second notification and no second email", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    await pump(ctx);
    const sentBefore = email.sent.length;
    const [ev] = await c.admin.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'taskId' = ${t.id} and ${outboxEvents.type} = 'task.assigned'`);
    await resetEvent(c.admin, ev!.id);
    await pump(ctx);
    expect((await notifs("mem1")).filter((n) => n.taskId === t.id)).toHaveLength(1);
    expect(email.sent.length).toBe(sentBefore);
  });

  it("removed assignees are told, with a generic type", async () => {
    const { ctx } = makeJobCtx(c.app);
    const t = await mkTask("mgr", { primaryAssigneeId: u.mem2!.id });
    await pump(ctx);
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    await pump(ctx);
    expect((await notifs("mem2")).filter((n) => n.taskId === t.id).map((n) => n.type)).toContain("task.unassigned");
  });
});

describe("recipients are re-checked, at creation and at delivery", () => {
  it("someone who lost access between the change and the email is not emailed, and their inbox shows no task data", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("mgr", { title: "Budget review SECRET-TITLE" });
    // team-scoped member is assigned while their team can see the project
    await run("admin", (s) => setAssignees(s, t.id, { primary: u.teamMem!.id, co: [] }));
    await outboxOnly(ctx); // creates the notification + queues the email job, but delivers nothing yet
    expect((await notifs("teamMem")).length).toBe(1);
    // access is withdrawn: the team no longer participates in the project
    await run("admin", (s) => setProjectTeams(s, O.project.id, []));
    const before = email.sent.length;
    await runJobs(ctx);
    expect(email.sent.slice(before).some((m) => m.to.startsWith("teamMem-"))).toBe(false);
    const attempts = await c.admin.select().from(deliveryAttempts).where(and(eq(deliveryAttempts.orgId, O.org.id), eq(deliveryAttempts.status, "skipped")));
    expect(attempts.some((a) => a.detail === "no_access")).toBe(true);
    const inbox = await withTenant(c.app, { userId: u.teamMem!.id, orgId: O.org.id }, (s) => listNotifications(s));
    expect(inbox.items[0]).toMatchObject({ visible: false, taskId: null });
    expect(JSON.stringify(inbox)).not.toContain("SECRET-TITLE");
    await run("admin", (s) => setProjectTeams(s, O.project.id, [O.team.id])); // restore for later tests
  });

  it("suspended members receive nothing", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem2!.id, co: [] }));
    await c.admin.update(memberships).set({ status: "suspended" }).where(and(eq(memberships.userId, u.mem2!.id), eq(memberships.orgId, O.org.id)));
    const before = email.sent.length;
    await pump(ctx);
    expect((await notifs("mem2")).filter((n) => n.taskId === t.id)).toHaveLength(0);
    expect(email.sent.slice(before).filter((m) => m.to.startsWith("mem2-"))).toHaveLength(0);
    await c.admin.update(memberships).set({ status: "approved" }).where(and(eq(memberships.userId, u.mem2!.id), eq(memberships.orgId, O.org.id)));
  });

  it("a task deleted before delivery produces a skipped email, not stale content", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("mgr", { title: "Doomed task" });
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    await outboxOnly(ctx);
    await run("mgr", (s) => deleteTask(s, t.id));
    const before = email.sent.length;
    await runJobs(ctx);
    expect(email.sent.slice(before).some((m) => m.text.includes("Doomed task"))).toBe(false);
  });

  it("events in one organization never create notifications in another", async () => {
    const { ctx } = makeJobCtx(c.app);
    const before = await c.admin.select().from(notifications).where(eq(notifications.orgId, X.org.id));
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    await pump(ctx);
    expect(await c.admin.select().from(notifications).where(eq(notifications.orgId, X.org.id))).toHaveLength(before.length);
  });

  it("outbox payloads and job payloads carry identifiers only", async () => {
    const t = await mkTask("mgr", { title: "UNIQUE-TITLE-ZZZ", description: "UNIQUE-BODY-ZZZ" });
    await run("mgr", (s) => addComment(s, t.id, { body: "UNIQUE-COMMENT-ZZZ" }));
    await run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "UNIQUE-TITLE-ZZZ2" }));
    const { ctx } = makeJobCtx(c.app);
    await pump(ctx);
    const events = JSON.stringify(await c.admin.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'taskId' = ${t.id}`));
    const jobRows = JSON.stringify(await c.admin.select().from(jobs).where(eq(jobs.orgId, O.org.id)));
    const notifRows = JSON.stringify(await c.admin.select().from(notifications).where(eq(notifications.orgId, O.org.id)));
    for (const text of [events, jobRows, notifRows]) expect(text).not.toMatch(/UNIQUE-(TITLE|BODY|COMMENT)-ZZZ/);
  });
});

describe("comments, mentions, status and dependencies", () => {
  it("mentioned users get a mention, other participants a comment, the author nothing, no duplicates", async () => {
    const { ctx } = makeJobCtx(c.app);
    const t = await mkTask("mgr", { primaryAssigneeId: u.mem1!.id, coAssigneeIds: [u.mem2!.id] });
    await pump(ctx);
    await run("mgr", (s) => addComment(s, t.id, { body: "hi @mem2", mentionUserIds: [u.mem2!.id] }));
    await pump(ctx);
    const types = (id: string) => notifs(id).then((r) => r.filter((n) => n.taskId === t.id).map((n) => n.type).sort());
    expect(await types("mem2")).toEqual(["task.assigned", "task.mentioned"]);
    expect(await types("mem1")).toEqual(["task.assigned", "task.commented"]);
    expect((await notifs("mgr")).filter((n) => n.taskId === t.id)).toHaveLength(0);
  });

  it("status changes reach participants; finishing a prerequisite notifies the dependents' assignees", async () => {
    const { ctx } = makeJobCtx(c.app);
    const pre = await mkTask("mgr", { primaryAssigneeId: u.mem1!.id });
    const dep = await mkTask("mgr", { primaryAssigneeId: u.mem2!.id });
    await run("mgr", (s) => addDependency(s, dep.id, pre.id));
    await pump(ctx);
    await run("mem1", async (s) => { await changeStatus(s, pre.id, "progress"); await changeStatus(s, pre.id, "done"); });
    await pump(ctx);
    expect((await notifs("mgr")).filter((n) => n.taskId === pre.id && n.type === "task.status_changed").length).toBe(2); // creator follows the task
    const depNote = (await notifs("mem2")).find((n) => n.taskId === dep.id && n.type === "task.dependency_changed");
    expect(depNote?.params).toEqual({ status: "done" });
  });
});

describe("email delivery behaviour", () => {
  it("quiet hours defer the email without burning an attempt, then it is sent once they end", async () => {
    const clock = { now: new Date("2026-06-10T16:30:00Z") }; // 23:30 in Bangkok
    const { ctx, email } = makeJobCtx(c.app, { clock });
    await withTenant(c.app, { userId: u.mem1!.id, orgId: O.org.id }, (s) => updateSettings(s, { quietStart: "22:00", quietEnd: "07:00" }));
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    const before = email.sent.length;
    await pump(ctx);
    expect(email.sent.slice(before).filter((m) => m.to.startsWith("mem1-"))).toHaveLength(0);
    const [nid] = (await notifs("mem1")).filter((n) => n.taskId === t.id);
    const [job] = await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `email:${nid!.id}`));
    expect(job).toMatchObject({ status: "pending", attempts: 0, lastError: "quiet_hours" });
    expect(job!.runAt.toISOString()).toBe("2026-06-11T00:00:00.000Z"); // 07:00 Bangkok
    expect((await notifs("mem1")).find((n) => n.id === nid!.id)!.inApp).toBe(true); // in-app is not delayed
    clock.now = new Date("2026-06-11T00:05:00Z");
    await pump(ctx);
    expect(email.sent.slice(before).filter((m) => m.to.startsWith("mem1-"))).toHaveLength(1);
    await c.admin.delete(notificationPrefs).where(eq(notificationPrefs.userId, u.mem1!.id));
  });

  it("retries a temporarily failing provider with backoff and delivers exactly once", async () => {
    const clock = { now: new Date() };
    const { ctx, email } = makeJobCtx(c.app, { clock });
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    email.failNext = new EmailError("provider down", true);
    const before = email.sent.length;
    await pump(ctx, 1);
    const [nid] = (await notifs("mem1")).filter((n) => n.taskId === t.id);
    let [job] = await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `email:${nid!.id}`));
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job!.runAt.getTime()).toBeGreaterThan(clock.now.getTime());
    expect(email.sent.length).toBe(before);
    clock.now = new Date(clock.now.getTime() + 120_000);
    await pump(ctx, 1);
    [job] = await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `email:${nid!.id}`));
    expect(job!.status).toBe("succeeded");
    expect(email.sent.slice(before).filter((m) => m.to.startsWith("mem1-"))).toHaveLength(1);
    expect(email.sent.at(-1)!.idempotencyKey).toBe(`notification-${nid!.id}`);
  });

  it("a provider rejection (bad address) is recorded and not retried", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    email.failNext = new EmailError("rejected", false);
    await pump(ctx, 1);
    const [nid] = (await notifs("mem1")).filter((n) => n.taskId === t.id);
    const [job] = await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `email:${nid!.id}`));
    expect(job).toMatchObject({ status: "dead", lastError: "EmailRejected" });
    const tries = await c.admin.select().from(deliveryAttempts).where(eq(deliveryAttempts.subjectId, nid!.id));
    expect(tries.map((x) => [x.status, x.detail])).toEqual([["failed", "rejected"]]);
  });

  it("an already-emailed notification is not sent again if its job runs twice", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    await pump(ctx);
    const [nid] = (await notifs("mem1")).filter((n) => n.taskId === t.id);
    const sent = email.sent.length;
    await c.admin.update(jobs).set({ status: "pending", runAt: new Date(), attempts: 0 }).where(eq(jobs.dedupeKey, `email:${nid!.id}`));
    await pump(ctx, 1);
    expect(email.sent.length).toBe(sent);
  });
});

describe("user settings", () => {
  it("honours per-event switches and defaults, validates input", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    await withTenant(c.app, { userId: u.mem2!.id, orgId: O.org.id }, (s) => updateSettings(s, { settings: [{ channel: "email", event: "task.assigned", enabled: false }] }));
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem2!.id, co: [] }));
    const before = email.sent.length;
    await pump(ctx);
    expect(email.sent.slice(before).filter((m) => m.to.startsWith("mem2-"))).toHaveLength(0);
    expect((await notifs("mem2")).filter((n) => n.taskId === t.id)).toHaveLength(1); // in-app still on by default
    const view = await withTenant(c.app, { userId: u.mem2!.id, orgId: O.org.id }, (s) => getSettings(s));
    expect(view.settings.find((x) => x.channel === "email" && x.event === "task.assigned")).toMatchObject({ enabled: false, isDefault: false });
    expect(view.settings.find((x) => x.channel === "email" && x.event === "task.commented")).toMatchObject({ enabled: false, isDefault: true });
    const ctxU = { userId: u.mem2!.id, orgId: O.org.id };
    expect(await code(withTenant(c.app, ctxU, (s) => updateSettings(s, { settings: [{ channel: "email", event: "task.bogus", enabled: true }] })))).toBe("VALIDATION");
    expect(await code(withTenant(c.app, ctxU, (s) => updateSettings(s, { quietStart: "25:00", quietEnd: "07:00" })))).toBe("VALIDATION");
    expect(await code(withTenant(c.app, ctxU, (s) => updateSettings(s, { quietStart: "22:00" })))).toBe("VALIDATION");
    await withTenant(c.app, ctxU, (s) => updateSettings(s, { settings: [{ channel: "email", event: "task.assigned", enabled: true }] }));
  });

  it("in-app off + email on stores the notification hidden from the inbox but still emails", async () => {
    const { ctx, email } = makeJobCtx(c.app);
    const ctxU = { userId: u.mem2!.id, orgId: O.org.id };
    await withTenant(c.app, ctxU, (s) => updateSettings(s, { settings: [{ channel: "in_app", event: "task.assigned", enabled: false }] }));
    const t = await mkTask("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem2!.id, co: [] }));
    const before = email.sent.length;
    await pump(ctx);
    expect(email.sent.slice(before).filter((m) => m.to.startsWith("mem2-"))).toHaveLength(1);
    const inbox = await withTenant(c.app, ctxU, (s) => listNotifications(s, { limit: 100 }));
    expect(inbox.items.some((i) => i.taskId === t.id)).toBe(false);
    await withTenant(c.app, ctxU, (s) => updateSettings(s, { settings: [{ channel: "in_app", event: "task.assigned", enabled: true }] }));
  });
});

describe("inbox API", () => {
  it("renders in the user's language, counts unread, marks read, and isolates users", async () => {
    const { ctx } = makeJobCtx(c.app);
    const t = await mkTask("mgr", { title: "Inbox task" });
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    await pump(ctx);
    const me = { userId: u.mem1!.id, orgId: O.org.id };
    const inbox = await withTenant(c.app, me, (s) => listNotifications(s, { limit: 100 }));
    const item = inbox.items.find((i) => i.taskId === t.id)!;
    expect(item).toMatchObject({ visible: true, read: false });
    expect(item.text).toContain('assigned you to "Inbox task"');
    const unread = await withTenant(c.app, me, (s) => unreadCount(s));
    expect(unread).toBeGreaterThan(0);
    // another user cannot mark my notifications read
    expect(await withTenant(c.app, { userId: u.mem2!.id, orgId: O.org.id }, (s) => markRead(s, [item.id]))).toBe(0);
    expect(await withTenant(c.app, me, (s) => markRead(s, [item.id]))).toBe(1);
    expect(await withTenant(c.app, me, (s) => unreadCount(s))).toBe(unread - 1);
    expect(await withTenant(c.app, me, (s) => markRead(s, "all"))).toBe(unread - 1);
    expect(await withTenant(c.app, me, (s) => unreadCount(s))).toBe(0);
    expect(await withTenant(c.app, { userId: u.xadmin!.id, orgId: X.org.id }, (s) => listNotifications(s))).toEqual({ items: [], hasMore: false });
  });

  it("the database refuses to let one user read another's notifications through the runtime role", async () => {
    const rows = await c.app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${X.org.id}, true)`);
      return tx.select().from(notifications);
    });
    expect(rows.every((r) => r.orgId === X.org.id)).toBe(true);
  });
});

// helpers --------------------------------------------------------------------------------------
import { outboxProcess } from "@/jobs/handlers/outbox";
import { registry } from "@/jobs/registry";
import { runWorker, type JobContext } from "@/jobs/worker";
import type { JobRow } from "@/jobs/queue";
async function outboxOnly(ctx: JobContext) { await outboxProcess(ctx, {} as JobRow); }
async function runJobs(ctx: JobContext) { await runWorker(ctx, registry, { maxMs: 4000, batch: 20 }); }
