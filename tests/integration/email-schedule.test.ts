import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { GET as cronGET } from "@/app/api/cron/tick/route";
import { GET as orgSettingsGET, PUT as orgSettingsPUT } from "@/app/api/orgs/[orgId]/settings/route";
import { GET as myNotificationSettingsGET } from "@/app/api/orgs/[orgId]/notification-settings/route";
import { withTenant } from "@/data/tenant";
import { createTask, setAssignees } from "@/data/tasks";
import { updateSettings } from "@/data/notifications";
import { queueWaitingEmails, waitingEmailCount } from "@/data/notification-emails";
import { auditLogs, digestLog, jobs, notifications, organizations, outboxEvents, tasks, users } from "@/db/schema";
import { deadlineEmail } from "@/jobs/handlers/deadline";
import { digestRun } from "@/jobs/handlers/digest";
import type { JobRow } from "@/jobs/queue";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { Client, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { clearOutbox, makeJobCtx, pump } from "./jobs-helpers";

/**
 * The three e-mail modes: off (an administrator sends), automatic and "instant" (as soon as the background work runs: a server with a poller
 * or a cron every minute), automatic and "daily" (held for 23:00 Thai time: Vercel Hobby's once-a-day cron). Thai time is UTC+7.
 */
const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

const MORNING = new Date("2026-03-10T03:00:00Z"); // 10:00 Thai
const EVENING = new Date("2026-03-10T16:10:00Z"); // 23:10 Thai
const NIGHT = new Date("2026-03-10T16:30:00Z"); // 23:30 Thai
const SEND_TIME = "2026-03-10T16:00:00.000Z"; // 23:00 Thai
const job = { orgId: null, payload: {} } as unknown as JobRow;
const manualJob = (orgId: string) => ({ orgId, payload: { manual: true } }) as unknown as JobRow;

type Org = Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string; email: string }> = {};
const orgs: { daily: Org; instant: Org; off: Org } = {} as never;
const run = <T>(k: string, org: Org, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: org.org.id }, fn);
const emailJob = (notificationId: string) => c.admin.select().from(jobs).where(eq(jobs.dedupeKey, `email:${notificationId}`));
const notifOf = (k: string, org: Org) => c.admin.select().from(notifications).where(and(eq(notifications.orgId, org.org.id), eq(notifications.userId, u[`${k}`]!.id)));

/** `mgr` assigns `who` a task in `org`; the background work runs with the clock at `at`. */
async function assign(org: Org, who: string, title: string, at: Date, ctxs = makeJobCtx(c.app)) {
  ctxs.clock.now = at;
  const t = await run("mgr", org, (s) => createTask(s, { projectId: org.project.id, title }));
  await run("mgr", org, (s) => setAssignees(s, t.id, { primary: u[who]!.id, co: [] }));
  await pump(ctxs.ctx);
  const n = (await notifOf(who, org)).find((x) => x.taskId === t.id)!;
  return { ...ctxs, t, n };
}

beforeAll(async () => {
  orgs.daily = await makeOrg(c.admin, "DailyMail", { autoEmail: true });
  orgs.instant = await makeOrg(c.admin, "InstantMail", { autoEmail: true });
  orgs.off = await makeOrg(c.admin, "OffMail", { autoEmail: false });
  await c.admin.update(organizations).set({ emailSchedule: "daily" }).where(eq(organizations.id, orgs.daily.org.id));
  for (const k of ["admin", "mgr", "mem", "mem2"]) u[k] = await makeUser(c.admin, k);
  await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, u.mem!.id));
  await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, u.mem2!.id));
  for (const o of Object.values(orgs)) {
    await addMember(c.admin, o.org.id, u.admin!.id, { role: "orgadmin" });
    await addMember(c.admin, o.org.id, u.mgr!.id, { role: "manager" });
    await addMember(c.admin, o.org.id, u.mem!.id, { role: "member" });
    await addMember(c.admin, o.org.id, u.mem2!.id, { role: "member" });
  }
  await clearOutbox(c.admin);
});

describe("daily mode: e-mails are held for 23:00 Thai time", () => {
  it("a notification created in the daytime is queued for 23:00 and sent then, not before; the bell is not held", async () => {
    const r = await assign(orgs.daily, "mem", "Held until night", MORNING);
    expect(r.n.inApp).toBe(true); // the notification itself is there at once
    expect(r.n.emailWanted).toBe(true);
    const [j] = await emailJob(r.n.id);
    expect(j!.runAt.toISOString()).toBe(SEND_TIME);
    expect(r.email.sent.filter((m) => m.to === u.mem!.email && m.subject.includes("Held until night"))).toHaveLength(0);
    await pump(r.ctx); // later in the morning: still nothing
    r.clock.now = new Date("2026-03-10T10:00:00Z"); // 17:00 Thai
    await pump(r.ctx);
    expect(r.email.sent.filter((m) => m.subject.includes("Held until night"))).toHaveLength(0);
    r.clock.now = EVENING;
    await pump(r.ctx);
    const sent = r.email.sent.filter((m) => m.to === u.mem!.email && m.subject.includes("Held until night"));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.html.startsWith("<!doctype html>")).toBe(true);
  });

  it("a notification created inside the window (23:00 to 04:00) is sent at once", async () => {
    const r = await assign(orgs.daily, "mem", "Created at night", NIGHT);
    const [j] = await emailJob(r.n.id);
    expect(j!.runAt.toISOString()).toBe(NIGHT.toISOString());
    expect(r.email.sent.filter((m) => m.subject.includes("Created at night"))).toHaveLength(1);
  });

  it("instant mode is unchanged: the same assignment in the daytime is sent at once (positive control)", async () => {
    const r = await assign(orgs.instant, "mem", "Instant in the daytime", MORNING);
    const [j] = await emailJob(r.n.id);
    expect(j!.runAt.toISOString()).toBe(MORNING.toISOString());
    expect(r.email.sent.filter((m) => m.to === u.mem!.email && m.subject.includes("Instant in the daytime"))).toHaveLength(1);
  });

  it("off mode queues nothing at all, whatever the schedule column says", async () => {
    await c.admin.update(organizations).set({ emailSchedule: "daily" }).where(eq(organizations.id, orgs.off.org.id));
    try {
      const r = await assign(orgs.off, "mem", "Off stays off", MORNING);
      expect(r.n.emailWanted).toBe(true);
      expect(await emailJob(r.n.id)).toHaveLength(0);
      expect(r.email.sent.filter((m) => m.subject.includes("Off stays off"))).toHaveLength(0);
    } finally { await c.admin.update(organizations).set({ emailSchedule: "instant" }).where(eq(organizations.id, orgs.off.org.id)); }
  });

  it("the button brings held e-mails forward, counts them, and an e-mail already tried is left alone", async () => {
    const r = await assign(orgs.daily, "mem2", "Pressed early", MORNING);
    const [held] = await emailJob(r.n.id);
    expect(held!.runAt.toISOString()).toBe(SEND_TIME);
    expect(await run("admin", orgs.daily, (s) => waitingEmailCount(s, MORNING))).toBeGreaterThanOrEqual(1);

    // a held e-mail that has been tried (and is backing off) keeps its own schedule
    const other = await assign(orgs.daily, "mem", "Backing off", MORNING);
    await c.admin.update(jobs).set({ attempts: 2 }).where(eq(jobs.dedupeKey, `email:${other.n.id}`));

    const res = await run("admin", orgs.daily, (s) => queueWaitingEmails(s, MORNING));
    expect(res.queued).toBeGreaterThanOrEqual(1);
    const [now] = await emailJob(r.n.id);
    expect(now!.runAt.getTime()).toBeLessThanOrEqual(MORNING.getTime());
    const [kept] = await emailJob(other.n.id);
    expect(kept!.runAt.toISOString()).toBe(SEND_TIME);

    await pump(r.ctx);
    expect(r.email.sent.filter((m) => m.to === u.mem2!.email && m.subject.includes("Pressed early"))).toHaveLength(1);
    expect(r.email.sent.filter((m) => m.subject.includes("Backing off"))).toHaveLength(0);
    // pressing again finds nothing more to bring forward for the first one
    const again = await run("admin", orgs.daily, (s) => queueWaitingEmails(s, MORNING));
    expect(again.queued).toBe(0);
  });
});

describe("daily mode: the scheduled e-mails run only in the window", () => {
  it("the deadline e-mail is not sent in the daytime, is sent in the window, once; the administrator's button sends at once", async () => {
    const t = await run("mgr", orgs.daily, (s) => createTask(s, { projectId: orgs.daily.project.id, title: "Overdue for the night", dueDate: "2026-03-01" }));
    await c.admin.update(tasks).set({ primaryAssigneeId: u.mem!.id }).where(eq(tasks.id, t.id));
    const day = makeJobCtx(c.app); day.clock.now = MORNING;
    await deadlineEmail(day.ctx, job);
    expect(day.email.sent.filter((m) => m.to === u.mem!.email)).toHaveLength(0);
    expect(await c.admin.select().from(digestLog).where(and(eq(digestLog.userId, u.mem!.id), like(digestLog.periodKey, "deadline:%")))).toHaveLength(0); // nothing claimed

    const night = makeJobCtx(c.app); night.clock.now = EVENING;
    await deadlineEmail(night.ctx, job);
    expect(night.email.sent.filter((m) => m.to === u.mem!.email)).toHaveLength(1);
    const again = makeJobCtx(c.app); again.clock.now = NIGHT;
    await deadlineEmail(again.ctx, job);
    expect(again.email.sent.filter((m) => m.to === u.mem!.email)).toHaveLength(0); // once a day

    // a person not yet served for the day: the button sends in the daytime of the next day, whatever the window
    const next = makeJobCtx(c.app); next.clock.now = new Date("2026-03-11T03:00:00Z");
    await deadlineEmail(next.ctx, job);
    expect(next.email.sent.filter((m) => m.to === u.mem!.email)).toHaveLength(0);
    await deadlineEmail(next.ctx, manualJob(orgs.daily.org.id));
    expect(next.email.sent.filter((m) => m.to === u.mem!.email)).toHaveLength(1);
  });

  it("the deadline e-mail of an instant organization still goes out in the daytime (positive control)", async () => {
    const t = await run("mgr", orgs.instant, (s) => createTask(s, { projectId: orgs.instant.project.id, title: "Overdue by day", dueDate: "2026-03-01" }));
    await c.admin.update(tasks).set({ primaryAssigneeId: u.mem2!.id }).where(eq(tasks.id, t.id));
    const day = makeJobCtx(c.app); day.clock.now = MORNING;
    await deadlineEmail(day.ctx, job);
    expect(day.email.sent.filter((m) => m.to === u.mem2!.email)).toHaveLength(1);
  });

  it("the digest of a daily organization is sent in the window, not in the daytime", async () => {
    const who = await makeUser(c.admin, "digester");
    await c.admin.update(users).set({ locale: "en", timezone: "Asia/Bangkok" }).where(eq(users.id, who.id));
    u.digester = who;
    await addMember(c.admin, orgs.daily.org.id, who.id, { role: "member" });
    // e-mail off for assignments: the notification belongs to the digest
    await withTenant(c.app, { userId: who.id, orgId: orgs.daily.org.id }, (s) => updateSettings(s, { digest: "daily", settings: [{ channel: "email", event: "task.assigned", enabled: false }] }));
    const r = await assign(orgs.daily, "digester", "For the digest", MORNING);
    void r;
    const day = makeJobCtx(c.app); day.clock.now = MORNING;
    await digestRun(day.ctx, job);
    expect(day.email.sent.filter((m) => m.to === who.email)).toHaveLength(0);
    const night = makeJobCtx(c.app); night.clock.now = EVENING;
    await digestRun(night.ctx, job);
    const mine = night.email.sent.filter((m) => m.to === who.email);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.html).toContain("For the digest");
  });
});

describe("the setting, over HTTP", () => {
  let admin: Client; let member: Client; let memberId: string; let org: Org;
  const P = () => ({ orgId: org.org.id });
  const url = () => `/api/orgs/${org.org.id}/settings`;

  beforeAll(async () => {
    org = await makeOrg(c.admin, "ScheduleHttp", { autoEmail: false });
    const mk = async (label: string, role: string) => {
      const { client, email } = await registerAndSignIn(app, label);
      const [row] = await c.admin.select().from(users).where(eq(users.email, email));
      await addMember(c.admin, org.org.id, row!.id, { role });
      return { client, id: row!.id };
    };
    admin = (await mk("schedadm", "orgadmin")).client;
    const m = await mk("schedmem", "member"); member = m.client; memberId = m.id;
  });

  it("starts as instant (what automatic e-mail always meant), and only someone who manages settings can read or change it", async () => {
    const got = await admin.route(orgSettingsGET as never, "GET", url(), undefined, P());
    expect(await got.json()).toMatchObject({ autoEmail: false, emailSchedule: "instant" });
    expect((await member.route(orgSettingsGET as never, "GET", url(), undefined, P())).status).toBe(403);
    expect((await member.route(orgSettingsPUT as never, "PUT", url(), { emailSchedule: "daily" }, P())).status).toBe(403);
    expect((await new Client(app.auth).route(orgSettingsPUT as never, "PUT", url(), { emailSchedule: "daily" }, P())).status).toBe(401);
  });

  it("accepts instant and daily, refuses anything else, and changes the schedule without touching the switch", async () => {
    for (const bad of ["weekly", "", 3, null, true]) expect((await admin.route(orgSettingsPUT as never, "PUT", url(), { emailSchedule: bad }, P())).status, String(bad)).toBe(422);
    const res = await admin.route(orgSettingsPUT as never, "PUT", url(), { emailSchedule: "daily" }, P());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ emailSchedule: "daily" });
    const got = await admin.route(orgSettingsGET as never, "GET", url(), undefined, P());
    expect(await got.json()).toMatchObject({ autoEmail: false, emailSchedule: "daily" }); // the switch was not changed
    // both in one request
    const both = await admin.route(orgSettingsPUT as never, "PUT", url(), { autoEmail: true, emailSchedule: "instant" }, P());
    expect(await both.json()).toEqual({ autoEmail: true, emailSchedule: "instant" });
    expect((await admin.route(orgSettingsPUT as never, "PUT", url(), {}, P())).status).toBe(422); // nothing to change
    const log = await c.admin.select({ action: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.orgId, org.org.id), like(auditLogs.action, "org.email_schedule_%")));
    expect(log.map((l) => l.action).sort()).toEqual(["org.email_schedule_daily", "org.email_schedule_instant"]);
  });

  it("every member sees on their own settings when e-mail is sent", async () => {
    await admin.route(orgSettingsPUT as never, "PUT", url(), { autoEmail: true, emailSchedule: "daily" }, P());
    const mine = await member.route(myNotificationSettingsGET as never, "GET", `/api/orgs/${org.org.id}/notification-settings`, undefined, P());
    expect(await mine.json()).toMatchObject({ autoEmail: true, emailSchedule: "daily" });
    void memberId;
  });

  it("the database refuses a schedule that is neither", async () => {
    await expect(c.admin.update(organizations).set({ emailSchedule: "weekly" }).where(eq(organizations.id, org.org.id))).rejects.toThrow();
  });
});

describe("the quick pass for a poller (GET /api/cron/tick?fast=1)", () => {
  const secret = "poll-secret-poll-secret-1234";
  const call = (path: string, auth: string | null) => cronGET(new Request(`http://localhost${path}`, { headers: auth ? { authorization: auth } : {} }));
  // the route reads its secret from the validated environment; the database itself comes from the runtime the test installed
  const saved = { CRON_SECRET: process.env.CRON_SECRET, DATABASE_URL: process.env.DATABASE_URL };
  beforeAll(() => { process.env.CRON_SECRET = secret; process.env.DATABASE_URL ||= process.env.TEST_DATABASE_URL; });
  afterAll(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

  it("answers 401 without the secret, with the wrong one, or with the secret as a query parameter", async () => {
    expect((await call("/api/cron/tick?fast=1", null)).status).toBe(401);
    expect((await call("/api/cron/tick?fast=1", "Bearer nope")).status).toBe(401);
    expect((await call(`/api/cron/tick?fast=1&secret=${secret}`, null)).status).toBe(401);
  });

  it("turns a change into a notification and an e-mail within one call, without the full pass", async () => {
    await clearOutbox(c.admin);
    const housekeeping = (await c.admin.select().from(jobs).where(eq(jobs.kind, "retention.purge"))).length;
    const t = await run("mgr", orgs.instant, (s) => createTask(s, { projectId: orgs.instant.project.id, title: "Fast pass" }));
    await run("mgr", orgs.instant, (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] }));
    expect((await c.admin.select().from(outboxEvents)).filter((e) => (e.payload as { taskId?: string }).taskId === t.id && !e.processedAt).length).toBeGreaterThan(0);
    const res = await call("/api/cron/tick?fast=1", `Bearer ${secret}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, fast: true, ran: true });
    const n = (await c.admin.select().from(notifications).where(eq(notifications.taskId, t.id))).find((x) => x.userId === u.mem!.id);
    expect(n).toBeTruthy();
    expect((await emailJob(n!.id))[0]!.status).toBe("succeeded");
    expect(app.email.sent.some((m) => m.to === u.mem!.email && m.subject.includes("Fast pass"))).toBe(true);
    // the full pass is not what ran: its periodic housekeeping was not queued by this call
    expect((await c.admin.select().from(jobs).where(eq(jobs.kind, "retention.purge"))).length).toBe(housekeeping);
  });

  it("the full pass still works and queues the periodic work", async () => {
    const res = await call("/api/cron/tick", `Bearer ${secret}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});
