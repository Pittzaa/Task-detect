import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { createTask, setAssignees } from "@/data/tasks";
import { updateSettings } from "@/data/notifications";
import { SEND_BATCH, WAITING_EMAIL_DAYS, queueWaitingEmails, waitingEmailCount } from "@/data/notification-emails";
import { auditLogs, digestLog, jobs, notifications, organizations, outboxEvents, users } from "@/db/schema";
import { digestRun } from "@/jobs/handlers/digest";
import { kick } from "@/jobs/kick";
import type { JobRow } from "@/jobs/queue";
import { registry } from "@/jobs/registry";
import { setAutoEmail } from "@/data/org-settings";
import { runWorker } from "@/jobs/worker";
import { AppError } from "@/lib/errors";
import { RETENTION } from "@/domain/retention";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { clearOutbox, makeJobCtx, pump } from "./jobs-helpers";

/**
 * Automatic e-mail OFF, how every organization starts and what suits Vercel Hobby: notifications inside the app are created as always,
 * no e-mail goes out by itself, and an administrator sends the waiting ones. With it ON (what makeOrg gives the other notification
 * tests) e-mails are queued at once; the first tests here cover both sides of the switch.
 */
const c = connect();
afterAll(() => c.close());
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };
const job = {} as JobRow;

let O: Awaited<ReturnType<typeof makeOrg>>; let X: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2], org = O) => withTenant(c.app, { userId: u[k]!.id, orgId: org.org.id }, fn);
const mkTask = (title: string) => run("mgr", (s) => createTask(s, { projectId: O.project.id, title }));
const notifsOf = (k: string, org = O) => c.admin.select().from(notifications).where(and(eq(notifications.orgId, org.org.id), eq(notifications.userId, u[k]!.id)));
const emailJobFor = (id: string) => c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `email:${id}`));

beforeAll(async () => {
  O = await makeOrg(c.admin, "ManualMailOrg", { autoEmail: false }); X = await makeOrg(c.admin, "ManualMailOther", { autoEmail: false });
  for (const k of ["admin", "mgr", "mem1", "mem2", "xadmin", "xmem"]) u[k] = await makeUser(c.admin, k);
  await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, u.mem1!.id));
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, O.org.id, u.mem1!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.mem2!.id, { role: "member" });
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
  await addMember(c.admin, X.org.id, u.xmem!.id, { role: "member" });
  await clearOutbox(c.admin);
});

/** Assigns `who` a fresh task as the manager and lets the background work run in manual mode; returns the mail sender's capture. */
async function assign(who: string, title: string, org = O) {
  const { ctx, email } = makeJobCtx(c.app);
  const actor = org === O ? "mgr" : "xadmin";
  const t = await run(actor, (s) => createTask(s, { projectId: org.project.id, title }), org);
  await run(actor, (s) => setAssignees(s, t.id, { primary: u[who]!.id, co: [] }), org);
  await pump(ctx);
  return { t, ctx, email };
}

describe("automatic e-mail off: the app is notified, e-mail waits", () => {
  it("creates the in-app notification, records that an e-mail is wanted, and sends and queues nothing", async () => {
    const { t, email } = await assign("mem1", "Manual one");
    const n = (await notifsOf("mem1")).find((x) => x.taskId === t.id && x.type === "task.assigned")!;
    expect(n.inApp).toBe(true);
    expect(n.emailWanted).toBe(true); // e-mail is on by default for assignments
    expect(await emailJobFor(n.id)).toHaveLength(0);
    expect(email.sent.filter((m) => m.to.startsWith("mem1-"))).toHaveLength(0);
    expect(n.emailedAt).toBeNull();
  });

  it("does not record an e-mail as wanted for an event the person switched e-mail off for", async () => {
    await run("mem2", (s) => updateSettings(s, { settings: [{ channel: "email", event: "task.assigned", enabled: false }] }));
    const { t } = await assign("mem2", "No mail wanted");
    const n = (await notifsOf("mem2")).find((x) => x.taskId === t.id)!;
    expect(n.emailWanted).toBe(false);
    await run("mem2", (s) => updateSettings(s, { settings: [{ channel: "email", event: "task.assigned", enabled: true }] }));
  });

  it("with automatic e-mail switched on by an administrator, the e-mail is queued straight away and sent", async () => {
    await run("admin", (s) => setAutoEmail(s, true));
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("Auto one");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    await pump(ctx);
    await run("admin", (s) => setAutoEmail(s, false));
    const n = (await notifsOf("mem1")).find((x) => x.taskId === t.id)!;
    expect(n.emailWanted).toBe(true);
    expect(n.emailedAt).not.toBeNull();
    expect(email.sent.filter((m) => m.to.startsWith("mem1-") && m.subject.includes("Auto one"))).toHaveLength(1);
  });
});

// these run the permission-checked functions as a given user
const countAs = (k: string, org = O) => run(k, (s) => waitingEmailCount(s), org);
const sendAs = (k: string, now?: Date, org = O) => run(k, (s) => queueWaitingEmails(s, now), org);

describe("sending the waiting e-mails", () => {
  it("queues them, delivers them through the normal job, marks them sent, and a second press queues nothing", async () => {
    await clearWaiting();
    const { t, ctx, email } = await assign("mem1", "Send me");
    const before = await countAs("admin");
    expect(before).toBe(1);

    const r = await sendAs("admin");
    expect(r).toEqual({ queued: 1, more: false });
    const n = (await notifsOf("mem1")).find((x) => x.taskId === t.id)!;
    expect(await emailJobFor(n.id)).toHaveLength(1);
    expect(await countAs("admin")).toBe(0); // handed to the sender: no longer waiting

    await runWorker(ctx, { "notification.email": registry["notification.email"]! }, { maxMs: 4000 });
    const mail = email.sent.find((m) => m.to.startsWith("mem1-") && m.subject.includes("Send me"))!;
    expect(mail.text).toContain(`/o/${O.org.id}/tasks?task=${t.id}`);
    expect((await notifsOf("mem1")).find((x) => x.id === n.id)!.emailedAt).not.toBeNull();

    expect(await sendAs("admin")).toEqual({ queued: 0, more: false });
    await runWorker(ctx, { "notification.email": registry["notification.email"]! }, { maxMs: 4000 });
    expect(email.sent.filter((m) => m.subject.includes("Send me"))).toHaveLength(1);
  });

  it("is for people who manage settings only, and shows nothing to anyone else", async () => {
    expect(await code(countAs("mem1"))).toBe("FORBIDDEN");
    expect(await code(sendAs("mem1"))).toBe("FORBIDDEN");
    expect(await code(sendAs("mgr"))).toBe("FORBIDDEN");
  });

  it("the waiting window never outlives the finished-job rows it relies on (a purged job must not make an e-mail look unsent)", () => {
    expect(WAITING_EMAIL_DAYS).toBeLessThanOrEqual(RETENTION.finishedJobDays);
  });

  it("leaves out notifications older than the waiting window, and does not touch another organization's", async () => {
    await clearWaiting();
    const { t } = await assign("mem1", "Stale news");
    const { t: tx } = await assign("xmem", "Other org news", X);
    const stale = (await notifsOf("mem1")).find((x) => x.taskId === t.id)!;
    await c.admin.update(notifications).set({ createdAt: new Date(Date.now() - (WAITING_EMAIL_DAYS + 1) * 86_400_000) }).where(eq(notifications.id, stale.id));
    expect(await countAs("admin")).toBe(0);
    expect(await sendAs("admin")).toEqual({ queued: 0, more: false });
    expect(await emailJobFor(stale.id)).toHaveLength(0);

    // the other organization's administrator sees and sends only their own
    expect(await countAs("xadmin", X)).toBe(1);
    const other = (await notifsOf("xmem", X)).find((x) => x.taskId === tx.id)!;
    expect(await sendAs("xadmin", undefined, X)).toEqual({ queued: 1, more: false });
    expect(await emailJobFor(other.id)).toHaveLength(1);
    // and this organization's administrator cannot reach it
    expect(await countAs("admin")).toBe(0);
  });

  it("queues at most one batch per press, oldest first, and says that more are waiting", async () => {
    await clearWaiting();
    const t = await mkTask("Batch");
    const rows = Array.from({ length: SEND_BATCH + 3 }, (_, i) => ({ orgId: O.org.id, userId: u.mem1!.id, type: "task.assigned", taskId: t.id, params: {}, dedupeKey: `batch:${i}:${t.id}`, inApp: true, emailWanted: true, createdAt: new Date(Date.now() - (SEND_BATCH + 10 - i) * 1000) }));
    await c.admin.insert(notifications).values(rows);
    try {
      expect(await countAs("admin")).toBe(SEND_BATCH + 3);
      const first = await sendAs("admin");
      expect(first).toEqual({ queued: SEND_BATCH, more: true });
      const second = await sendAs("admin");
      expect(second).toEqual({ queued: 3, more: false });
      // the oldest went first
      const oldest = (await c.admin.select().from(notifications).where(eq(notifications.dedupeKey, `batch:0:${t.id}`)))[0]!;
      expect(await emailJobFor(oldest.id)).toHaveLength(1);
    } finally {
      // 503 pending e-mail jobs must not be left for the next test's worker
      const ids = (await c.admin.select({ id: notifications.id }).from(notifications).where(like(notifications.dedupeKey, `batch:%:${t.id}`))).map((r) => r.id);
      if (ids.length) await c.admin.delete(jobs).where(inArray(jobs.dedupeKey, ids.map((i) => `email:${i}`)));
      await c.admin.delete(notifications).where(like(notifications.dedupeKey, `batch:%:${t.id}`));
    }
  });

  it("writes an audit entry with the number queued and no recipient or content", async () => {
    await clearWaiting();
    await assign("mem1", "Audit me");
    const r = await sendAs("admin");
    const [a] = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "notification.send_waiting_emails"))).orderBy(sql`${auditLogs.createdAt} desc`).limit(1);
    expect(a?.metadata).toEqual({ queued: r.queued });
    expect(a?.actorUserId).toBe(u.admin!.id);
  });
});

/** Takes everything that is waiting out of the way so each test counts only its own. */
async function clearWaiting() {
  await c.admin.update(notifications).set({ emailWanted: false }).where(and(inArray(notifications.orgId, [O.org.id, X.org.id]), eq(notifications.emailWanted, true), sql`${notifications.emailedAt} is null`));
}

describe("digests follow the switch", () => {
  it("are sent only for an organization that switched automatic e-mail on", async () => {
    await run("mem1", (s) => updateSettings(s, { digest: "daily" }));
    const { ctx, clock, email } = makeJobCtx(c.app);
    clock.now = new Date("2026-06-20T01:00:00Z"); // 08:00 Bangkok, when the daily digest is due
    await digestRun(ctx, job);
    expect(email.sent.filter((m) => m.to.startsWith("mem1-"))).toHaveLength(0); // switch off: nothing, and the period is not used up
    expect(await c.admin.select().from(digestLog).where(eq(digestLog.userId, u.mem1!.id))).toHaveLength(0);

    await run("admin", (s) => setAutoEmail(s, true));
    try {
      await digestRun(ctx, job);
      expect(email.sent.filter((m) => m.to.startsWith("mem1-") && /daily/i.test(m.subject))).toHaveLength(1);
    } finally {
      await run("admin", (s) => setAutoEmail(s, false));
      await run("mem1", (s) => updateSettings(s, { digest: "off" }));
    }
  });

  it("the switch is the organization's own: only an administrator flips it, it is audited, and another organization is untouched", async () => {
    expect(await code(run("mgr", (s) => setAutoEmail(s, true)))).toBe("FORBIDDEN");
    expect(await code(run("mem1", (s) => setAutoEmail(s, true)))).toBe("FORBIDDEN");
    expect(await run("admin", (s) => setAutoEmail(s, true))).toEqual({ autoEmail: true });
    try {
      const [o] = await c.admin.select({ a: organizations.autoEmail }).from(organizations).where(eq(organizations.id, O.org.id));
      const [x] = await c.admin.select({ a: organizations.autoEmail }).from(organizations).where(eq(organizations.id, X.org.id));
      expect([o!.a, x!.a]).toEqual([true, false]);
    } finally { await run("admin", (s) => setAutoEmail(s, false)); }
    const actions = (await c.admin.select({ a: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.actorUserId, u.admin!.id)))).map((r) => r.a);
    expect(actions).toEqual(expect.arrayContaining(["org.auto_email_on", "org.auto_email_off"]));
  });

  it("the runtime role may change this one setting of its own organization and nothing else on it", async () => {
    await expect(c.app.execute(sql`update organizations set name = 'x' where id = ${O.org.id}`)).rejects.toThrow();
  });
});

describe("work that follows requests", () => {
  it("a kick delivers a pending change to the other person's notifications without any scheduler, and (switch off) nothing is e-mailed", async () => {
    await clearOutbox(c.admin);
    const { ctx, email } = makeJobCtx(c.app);
    const t = await mkTask("Kicked");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem1!.id, co: [] }));
    expect((await notifsOf("mem1")).filter((n) => n.taskId === t.id)).toHaveLength(0); // nothing has run yet
    expect(await kick(ctx, { force: true })).toBe(true);
    const n = (await notifsOf("mem1")).filter((x) => x.taskId === t.id);
    expect(n).toHaveLength(1);
    expect(n[0]!.emailWanted).toBe(true);
    expect(email.sent.filter((m) => m.subject.includes("Kicked"))).toHaveLength(0);
    expect(await c.admin.select().from(outboxEvents).where(sql`${outboxEvents.processedAt} is null and ${outboxEvents.payload}->>'taskId' = ${t.id}`)).toHaveLength(0);
  });

  it("is throttled per instance: a second request moments later does not start another run", async () => {
    await clearOutbox(c.admin);
    const { ctx } = makeJobCtx(c.app);
    expect(await kick(ctx, { force: true })).toBe(true);
    expect(await kick(ctx)).toBe(false);
  });

  it("leaves the heavy maintenance jobs to the daily cron instead of queueing them where nothing will run them", async () => {
    const { ctx } = makeJobCtx(c.app);
    const when = new Date(Date.now() + 900 * 86_400_000);
    ctx.now = () => when;
    await kick(ctx, { force: true });
    for (const [kind, secs] of [["retention.purge", 86_400], ["storage.orphans", 7 * 86_400], ["calendar.reconcile", 86_400], ["digest.run", 3600]] as const) {
      expect(await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `tick:${kind}:${Math.floor(when.getTime() / (secs * 1000))}`)), kind).toHaveLength(0);
    }
    expect(await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `tick:reminders.scan:${Math.floor(when.getTime() / 300_000)}`))).toHaveLength(1);
  });
});
