import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { setProjectTeams } from "@/data/structure";
import { changeStatus, createTask, deleteTask, restoreTask, setAssignees, updateTask } from "@/data/tasks";
import { calendarStatus, disconnectCalendar, finishCalendarConnect, requestResync, startCalendarConnect } from "@/data/calendar";
import { AppError } from "@/lib/errors";
import { appRateLimits, calendarConnections, calendarEventLinks, jobs, oauthStates, tasks } from "@/db/schema";
import { createGoogleClient, eventIdFor, GoogleError } from "@/integrations/google-calendar";
import { calendarSyncTask } from "@/jobs/handlers/calendar";
import type { JobRow } from "@/jobs/queue";
import { enqueue } from "@/jobs/queue";
import { addDays, todayIn } from "@/domain/time";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { KEY, clearOutbox, makeJobCtx, pump } from "./jobs-helpers";
import { FakeGoogle } from "./google-fake";

const c = connect();
afterAll(() => c.close());
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };
const deps = { encryptionKeys: [KEY] };

let O: Awaited<ReturnType<typeof makeOrg>>; let X: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: O.org.id }, fn);
const mkTask = (over: Partial<Parameters<typeof createTask>[1]> = {}) => run("mgr", (s) => createTask(s, { projectId: O.project.id, title: "Calendar task", startDate: "2026-07-01", dueDate: "2026-07-03", ...over }));

let g: FakeGoogle;
let google: ReturnType<typeof createGoogleClient>;
let jobCtx: ReturnType<typeof makeJobCtx>;

/** Creates an unassigned task, settles its events, then assigns it, so exactly one sync job is produced. */
async function assignedLater(userKey: string, over: Partial<Parameters<typeof createTask>[1]> = {}) {
  const t = await mkTask(over);
  await pump(jobCtx.ctx);
  await run("mgr", (s) => setAssignees(s, t.id, { primary: u[userKey]!.id, co: [] }));
  return t;
}

/** Connects `userKey` through the real start/finish flow against the fake. */
async function connectUser(userKey: string, org = O) {
  const auth = { userId: u[userKey]!.id, orgId: org.org.id };
  const { url } = await startCalendarConnect(c.app, auth, google, deps);
  const state = new URL(url).searchParams.get("state")!;
  const code = g.issueCode(url);
  await finishCalendarConnect(c.app, auth.userId, { code, state }, google, deps);
  const [conn] = await c.admin.select().from(calendarConnections).where(and(eq(calendarConnections.userId, auth.userId), eq(calendarConnections.orgId, org.org.id)));
  return conn!;
}

beforeAll(async () => {
  O = await makeOrg(c.admin, "CalOrg"); X = await makeOrg(c.admin, "CalOther");
  for (const k of ["admin", "mgr", "ann", "bob", "teamMem", "xann"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, O.org.id, u.ann!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.bob!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.teamMem!.id, { role: "member", scope: { type: "team", id: O.team.id } });
  await addMember(c.admin, X.org.id, u.xann!.id, { role: "member" });
  await run("admin", (s) => setProjectTeams(s, O.project.id, [O.team.id]));
});

beforeEach(async () => {
  g = new FakeGoogle();
  google = createGoogleClient(g.config(), g.fetch);
  jobCtx = makeJobCtx(c.app, { fetchImpl: g.fetch, google: g.config() });
  await c.admin.delete(calendarConnections).where(eq(calendarConnections.orgId, O.org.id)).catch(async () => {
    await c.admin.delete(calendarEventLinks).where(eq(calendarEventLinks.orgId, O.org.id));
    await c.admin.delete(calendarConnections).where(eq(calendarConnections.orgId, O.org.id));
  });
  await c.admin.delete(appRateLimits);
  await c.admin.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.orgId, O.org.id)); // each test starts with an empty project
  await clearOutbox(c.admin);
  await c.admin.update(jobs).set({ status: "dead" }).where(and(eq(jobs.orgId, O.org.id), sql`${jobs.status} in ('pending','running')`));
});

describe("connecting (OAuth with PKCE)", () => {
  it("builds a consent URL with a one-time state, S256 challenge, offline access and only the events scope", async () => {
    const { url } = await startCalendarConnect(c.app, { userId: u.ann!.id, orgId: O.org.id }, google, deps);
    const p = new URL(url).searchParams;
    expect(p.get("scope")).toBe("https://www.googleapis.com/auth/calendar.events");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(p.get("redirect_uri")).toBe("http://localhost:3000/api/calendar/callback");
  });

  it("completes the flow, stores only an encrypted refresh token bound to the connection, and never exposes it", async () => {
    const conn = await connectUser("ann");
    expect(conn.status).toBe("active");
    expect(conn.refreshTokenCiphertext).not.toMatch(/rt-\d/);
    const status = await run("ann", (s) => calendarStatus(s));
    expect(status).toMatchObject({ connected: true, status: "active", linkedEvents: 0 });
    expect(JSON.stringify(status)).not.toMatch(/rt-|ciphertext|token/i);
    const dump = JSON.stringify(await c.admin.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id)));
    expect(dump).not.toMatch(/"rt-\d|at-\d/);
    expect(await run("bob", (s) => calendarStatus(s))).toEqual({ connected: false });
  });

  it("state is single-use, user-bound, expiring; a failed exchange or missing scope is rejected", async () => {
    const auth = { userId: u.ann!.id, orgId: O.org.id };
    const { url } = await startCalendarConnect(c.app, auth, google, deps);
    const state = new URL(url).searchParams.get("state")!;
    const goodCode = g.issueCode(url);
    // another user presenting ann's state
    expect(await code(finishCalendarConnect(c.app, u.bob!.id, { code: goodCode, state }, google, deps))).toBe("NOT_FOUND");
    await finishCalendarConnect(c.app, auth.userId, { code: goodCode, state }, google, deps);
    expect(await code(finishCalendarConnect(c.app, auth.userId, { code: g.issueCode(url), state }, google, deps))).toBe("NOT_FOUND"); // replay
    // expired
    const second = await startCalendarConnect(c.app, auth, google, deps);
    const st2 = new URL(second.url).searchParams.get("state")!;
    await c.admin.update(oauthStates).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(oauthStates.userId, auth.userId));
    expect(await code(finishCalendarConnect(c.app, auth.userId, { code: g.issueCode(second.url), state: st2 }, google, deps))).toBe("NOT_FOUND");
    // bad code (PKCE mismatch / unknown)
    const third = await startCalendarConnect(c.app, auth, google, deps);
    expect(await code(finishCalendarConnect(c.app, auth.userId, { code: "bogus", state: new URL(third.url).searchParams.get("state")! }, google, deps))).toBe("VALIDATION");
    // scope not granted
    g.scopeGranted = "openid";
    const fourth = await startCalendarConnect(c.app, auth, google, deps);
    expect(await code(finishCalendarConnect(c.app, auth.userId, { code: g.issueCode(fourth.url), state: new URL(fourth.url).searchParams.get("state")! }, google, deps))).toBe("VALIDATION");
  });

  it("someone with no access in the org cannot start a connection", async () => {
    const lone = await makeUser(c.admin, "callone");
    await addMember(c.admin, O.org.id, lone.id, {});
    expect(await code(startCalendarConnect(c.app, { userId: lone.id, orgId: O.org.id }, google, deps))).toBe("FORBIDDEN");
    expect(await code(startCalendarConnect(c.app, { userId: u.xann!.id, orgId: O.org.id }, google, deps))).toBe("NOT_FOUND");
  });

  it("reconnecting keeps the same connection id, so event ids stay stable", async () => {
    const first = await connectUser("ann");
    const second = await connectUser("ann");
    expect(second.id).toBe(first.id);
    expect((await c.admin.select().from(calendarConnections).where(eq(calendarConnections.userId, u.ann!.id)))).toHaveLength(1);
  });
});

describe("one-way sync: tasks -> calendar", () => {
  it("creates one all-day event for a task assigned to the connected user, exporting only title, dates, status and a link", async () => {
    const conn = await connectUser("ann");
    const t = await mkTask({ title: "Quarterly review", description: "CONFIDENTIAL minutes and numbers", primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(1);
    const ev = g.eventList()[0]!;
    expect(ev).toMatchObject({ summary: "Quarterly review", start: { date: "2026-07-01" }, end: { date: "2026-07-04" }, transparency: "transparent", id: eventIdFor(conn.id, t.id) });
    expect(JSON.stringify(ev)).not.toContain("CONFIDENTIAL");
    expect(String(ev.description)).toContain(`/o/${O.org.id}/tasks/${t.id}`);
    const [link] = await c.admin.select().from(calendarEventLinks).where(eq(calendarEventLinks.connectionId, conn.id));
    expect(link).toMatchObject({ taskId: t.id, googleEventId: eventIdFor(conn.id, t.id), failures: 0 });
    expect((await run("ann", (s) => calendarStatus(s)))).toMatchObject({ linkedEvents: 1, failingEvents: 0 });
  });

  it("only syncs tasks the user is assigned to and can read; other people's and undated tasks produce nothing", async () => {
    await connectUser("ann");
    await mkTask({ primaryAssigneeId: u.bob!.id });
    await mkTask({ primaryAssigneeId: u.ann!.id, startDate: null, dueDate: null });
    await mkTask({});
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(0);
    expect(g.writes()).toHaveLength(0);
  });

  it("co-assignees get the event too; only the connected ones", async () => {
    await connectUser("ann"); await connectUser("bob");
    const t = await mkTask({ primaryAssigneeId: u.ann!.id, coAssigneeIds: [u.bob!.id] });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(2);
    expect(new Set(g.eventList().map((e) => e.id)).size).toBe(2);
    void t;
  });

  it("applies the documented policy for edits, completion, cancellation, reschedule, deletion and restore", async () => {
    const conn = await connectUser("ann");
    const t = await mkTask({ title: "Policy task", primaryAssigneeId: u.ann!.id });
    const id = eventIdFor(conn.id, t.id);
    const ev = () => g.events.get(`primary/${id}`);
    await pump(jobCtx.ctx);
    expect(ev()?.summary).toBe("Policy task");

    await run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "Renamed", dueDate: "2026-07-10" }));
    await pump(jobCtx.ctx);
    expect(ev()).toMatchObject({ summary: "Renamed", end: { date: "2026-07-11" } }); // rescheduled

    await run("ann", async (s) => { await changeStatus(s, t.id, "progress"); await changeStatus(s, t.id, "done"); });
    await pump(jobCtx.ctx);
    expect(ev()?.summary).toBe("✓ Renamed"); // done keeps the event, marked

    await run("mgr", (s) => changeStatus(s, t.id, "todo")); // reopen
    await pump(jobCtx.ctx);
    expect(ev()?.summary).toBe("Renamed");

    await run("mgr", (s) => changeStatus(s, t.id, "cancelled"));
    await pump(jobCtx.ctx);
    expect(ev()).toBeUndefined(); // cancelled => removed
    expect(await c.admin.select().from(calendarEventLinks).where(eq(calendarEventLinks.taskId, t.id))).toHaveLength(0);

    await run("mgr", (s) => changeStatus(s, t.id, "todo"));
    await pump(jobCtx.ctx);
    expect(ev()?.summary).toBe("Renamed"); // recreated under the SAME id
    expect(g.eventList()).toHaveLength(1);

    await run("mgr", (s) => deleteTask(s, t.id));
    await pump(jobCtx.ctx);
    expect(ev()).toBeUndefined();
    await run("mgr", (s) => restoreTask(s, t.id));
    await pump(jobCtx.ctx);
    expect(ev()).toBeDefined();
  });

  it("removes the event when the user is unassigned, or when the due/start dates are cleared", async () => {
    const conn = await connectUser("ann");
    const t = await mkTask({ primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(1);
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.bob!.id, co: [] }));
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(0);
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.ann!.id, co: [] }));
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(1);
    const cur = await run("mgr", async (s) => (await import("@/data/tasks")).getTask(s, t.id));
    await run("mgr", (s) => updateTask(s, t.id, { version: cur.version, startDate: null, dueDate: null }));
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(0);
    void conn;
  });

  it("removes the event when the user loses access to the task and does not recreate it", async () => {
    await connectUser("teamMem");
    const t = await mkTask({ primaryAssigneeId: u.teamMem!.id });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(1);
    await run("admin", (s) => setProjectTeams(s, O.project.id, [])); // the team no longer sees this project
    // any later event for the task triggers a re-evaluation
    await run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "touch" }));
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(0);
    await run("admin", (s) => setProjectTeams(s, O.project.id, [O.team.id]));
  });

  it("an unchanged task causes no API writes (idempotent), however many times the job runs", async () => {
    await connectUser("ann");
    const t = await mkTask({ primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    const writes = g.writes().length;
    for (let i = 0; i < 3; i++) await calendarSyncTask(jobCtx.ctx, { orgId: O.org.id, payload: { connectionId: (await c.admin.select().from(calendarConnections).where(eq(calendarConnections.userId, u.ann!.id)))[0]!.id, taskId: t.id } } as unknown as JobRow);
    expect(g.writes().length).toBe(writes);
  });

  it("NEVER READS Google Calendar: no GET on events, no read method on the client, and Google-side edits do not flow back", async () => {
    const conn = await connectUser("ann");
    const t = await mkTask({ title: "One way", primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    // someone edits and deletes the event inside Google
    const key = `primary/${eventIdFor(conn.id, t.id)}`;
    g.events.set(key, { ...g.events.get(key)!, summary: "HACKED IN GOOGLE" });
    await run("mgr", (s) => updateTask(s, t.id, { version: 1, priority: "high" })); // does not alter the exported payload
    await pump(jobCtx.ctx);
    const cur = await run("mgr", async (s) => (await import("@/data/tasks")).getTask(s, t.id));
    expect(cur.title).toBe("One way"); // the task never changes because of Google
    expect(g.reads()).toHaveLength(0);
    expect(Object.keys(google).sort()).toEqual(["authorizeUrl", "deleteEvent", "exchangeCode", "refresh", "revoke", "upsertEvent"]);
    // our next real change overwrites the foreign edit with the app's truth
    await run("mgr", (s) => updateTask(s, t.id, { version: cur.version, title: "One way v2" }));
    await pump(jobCtx.ctx);
    expect(g.events.get(key)?.summary).toBe("One way v2");
  });
});

describe("duplicate prevention", () => {
  it("adopts an event that exists in Google but was never linked (crash after create): exactly one event results", async () => {
    const conn = await connectUser("ann");
    const t = await mkTask({ primaryAssigneeId: u.ann!.id });
    const id = eventIdFor(conn.id, t.id);
    g.events.set(`primary/${id}`, { id, summary: "stale copy from an earlier attempt" });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(1);
    expect(g.events.get(`primary/${id}`)?.summary).toBe(t.title);
    expect(g.writes().filter((x) => x.method === "POST")).toHaveLength(1);
    expect(g.writes().filter((x) => x.method === "PUT")).toHaveLength(1);
  });

  it("two sync jobs racing for the same task yield one event", async () => {
    const conn = await connectUser("ann");
    const t = await mkTask({ primaryAssigneeId: u.ann!.id });
    await clearOutbox(c.admin);
    const job = { orgId: O.org.id, payload: { connectionId: conn.id, taskId: t.id } } as unknown as JobRow;
    await Promise.all([calendarSyncTask(jobCtx.ctx, job), calendarSyncTask(jobCtx.ctx, job), calendarSyncTask(jobCtx.ctx, job)]);
    expect(g.eventList()).toHaveLength(1);
    expect(await c.admin.select().from(calendarEventLinks).where(eq(calendarEventLinks.connectionId, conn.id))).toHaveLength(1);
  });

  it("an edit that lands while a sync is in flight is not lost (the job re-checks and goes around again)", async () => {
    await connectUser("ann");
    const t = await mkTask({ title: "Before", primaryAssigneeId: u.ann!.id });
    let fired = false;
    g.onWrite = async () => {
      if (fired) return;
      fired = true;
      await run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "After" }));
    };
    await pump(jobCtx.ctx, 4);
    expect(g.eventList()).toHaveLength(1);
    expect(g.eventList()[0]!.summary).toBe("After");
  });

  it("a stale link whose event was deleted in Google is recreated on the next change (404 on update -> insert)", async () => {
    const conn = await connectUser("ann");
    const t = await mkTask({ title: "Gone in Google", primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    g.events.delete(`primary/${eventIdFor(conn.id, t.id)}`);
    await run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "Gone in Google 2" }));
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(1);
    expect(g.eventList()[0]!.summary).toBe("Gone in Google 2");
  });
});

describe("failure handling", () => {
  it("rate limits (429 with Retry-After, and Calendar's 403 quota error) defer the job without consuming attempts", async () => {
    const conn = await connectUser("ann");
    const t = await assignedLater("ann");
    g.failures.push({ match: "POST events", status: 429, headers: { "retry-after": "30" } });
    await pump(jobCtx.ctx, 1);
    let [job] = await c.admin.select().from(jobs).where(and(eq(jobs.kind, "calendar.sync_task"), sql`${jobs.payload}->>'taskId' = ${t.id}`));
    expect(job).toMatchObject({ status: "pending", attempts: 0, lastError: "google_rate_limited" });
    expect(g.eventList()).toHaveLength(0);
    jobCtx.clock.now = new Date(Date.now() + 120_000);
    g.failures.push({ match: "POST events", status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } });
    await pump(jobCtx.ctx, 1);
    jobCtx.clock.now = new Date(Date.now() + 240_000);
    await pump(jobCtx.ctx, 1);
    expect(g.eventList()).toHaveLength(1);
    [job] = await c.admin.select().from(jobs).where(and(eq(jobs.kind, "calendar.sync_task"), sql`${jobs.payload}->>'taskId' = ${t.id}`));
    expect(job!.status).toBe("succeeded");
    void conn;
  });

  it("transient server errors retry with backoff and then succeed once", async () => {
    await connectUser("ann");
    const t = await assignedLater("ann");
    g.failures.push({ match: "POST events", status: 503 });
    await pump(jobCtx.ctx, 1);
    expect(g.eventList()).toHaveLength(0);
    const [job] = await c.admin.select().from(jobs).where(and(eq(jobs.kind, "calendar.sync_task"), sql`${jobs.payload}->>'taskId' = ${t.id}`));
    expect(job).toMatchObject({ status: "pending", attempts: 1 });
    expect(job!.lastError).toMatch(/Error/);
    jobCtx.clock.now = new Date(Date.now() + 300_000);
    await pump(jobCtx.ctx, 1);
    expect(g.eventList()).toHaveLength(1);
    const [link] = await c.admin.select().from(calendarEventLinks).where(eq(calendarEventLinks.taskId, t.id));
    expect(link!.failures).toBe(0);
  });

  it("a revoked Google grant marks the connection revoked, kills the job, and stops all future syncing for it", async () => {
    const conn = await connectUser("ann");
    g.refreshTokens.clear(); // Google now answers invalid_grant
    const t = await mkTask({ primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    const [after] = await c.admin.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id));
    expect(after).toMatchObject({ status: "revoked", lastError: "access_revoked" });
    const [job] = await c.admin.select().from(jobs).where(and(eq(jobs.kind, "calendar.sync_task"), sql`${jobs.payload}->>'taskId' = ${t.id}`));
    expect(job).toMatchObject({ status: "dead", lastError: "GoogleAccessRevoked" });
    const before = await c.admin.select().from(jobs).where(eq(jobs.kind, "calendar.sync_task"));
    await mkTask({ primaryAssigneeId: u.ann!.id, title: "later" });
    await pump(jobCtx.ctx);
    expect((await c.admin.select().from(jobs).where(eq(jobs.kind, "calendar.sync_task"))).length).toBe(before.length); // revoked connections get no new jobs
    expect(await run("ann", (s) => calendarStatus(s))).toMatchObject({ status: "revoked" });
    expect(await code(run("ann", (s) => requestResync(s)))).toBe("CONFLICT");
  });

  it("permanent API errors are recorded as sanitized classes on the link and connection", async () => {
    const conn = await connectUser("ann");
    const t = await mkTask({ primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    g.failures.push({ match: "PUT events", status: 400, body: { error: { message: "SENSITIVE detail" } } });
    await run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "will fail" }));
    await pump(jobCtx.ctx, 1);
    const [link] = await c.admin.select().from(calendarEventLinks).where(eq(calendarEventLinks.taskId, t.id));
    expect(link).toMatchObject({ failures: 1, lastError: "permanent:400" });
    expect(JSON.stringify(await c.admin.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id)))).not.toContain("SENSITIVE");
    expect(await run("ann", (s) => calendarStatus(s))).toMatchObject({ failingEvents: 1 });
  });

  it("GoogleError classification", async () => {
    const r = (status: number, headers: Record<string, string> = {}) => createGoogleClient(g.config(), (async () => new Response("{}", { status, headers })) as typeof fetch).upsertEvent("t", "primary", "id", { summary: "x" } as never, false);
    await expect(r(500)).rejects.toMatchObject({ kind: "transient" });
    await expect(r(429, { "retry-after": "5" })).rejects.toMatchObject({ kind: "rate_limited", retryAfterMs: 5000 });
    await expect(r(401)).rejects.toMatchObject({ kind: "revoked" });
    await expect(r(400)).rejects.toMatchObject({ kind: "permanent" });
    expect(new GoogleError("transient", 0).kind).toBe("transient");
  });
});

describe("resync, reconcile and disconnect", () => {
  it("connecting queues a resync that backfills everything assigned (including tasks created before connecting)", async () => {
    // The backfill window is [today - 30 days, today + 365 days], so use dates relative to now.
    const soon = { startDate: addDays(todayIn("UTC"), 3), dueDate: addDays(todayIn("UTC"), 5) };
    const t1 = await mkTask({ ...soon, title: "Before connect 1", primaryAssigneeId: u.ann!.id });
    const t2 = await mkTask({ ...soon, title: "Before connect 2", coAssigneeIds: [u.ann!.id] });
    await mkTask({ ...soon, title: "Not mine", primaryAssigneeId: u.bob!.id });
    await mkTask({ startDate: "2020-01-01", dueDate: "2020-01-02", title: "Ancient (outside window)", primaryAssigneeId: u.ann!.id });
    await clearOutbox(c.admin);
    await connectUser("ann");
    await pump(jobCtx.ctx);
    expect(g.eventList().map((e) => e.summary).sort()).toEqual(["Before connect 1", "Before connect 2"]);
    void t1; void t2;
  });

  it("manual resync is rate limited and re-adds missing events but is otherwise a no-op", async () => {
    await connectUser("ann");
    await mkTask({ primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    const writes = g.writes().length;
    await run("ann", (s) => requestResync(s));
    await pump(jobCtx.ctx);
    expect(g.writes().length).toBe(writes);
    const codes: string[] = [];
    for (let i = 0; i < 7; i++) codes.push(await code(run("ann", (s) => requestResync(s))));
    expect(codes).toContain("RATE_LIMITED");
  });

  it("disconnect with deleteEvents removes our events, revokes the token and deletes the connection", async () => {
    const conn = await connectUser("ann");
    await mkTask({ primaryAssigneeId: u.ann!.id }); await mkTask({ primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(2);
    await run("ann", (s) => disconnectCalendar(s, { deleteEvents: true }));
    expect(await run("ann", (s) => calendarStatus(s))).toMatchObject({ status: "disconnecting" });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(0);
    expect(g.revokedTokens).toHaveLength(1);
    expect(await c.admin.select().from(calendarConnections).where(eq(calendarConnections.id, conn.id))).toHaveLength(0);
    expect(await run("ann", (s) => calendarStatus(s))).toEqual({ connected: false });
  });

  it("disconnect without deleteEvents leaves existing events alone but stops syncing", async () => {
    await connectUser("ann");
    const t = await mkTask({ primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    await run("ann", (s) => disconnectCalendar(s, { deleteEvents: false }));
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(1);
    expect(g.revokedTokens).toHaveLength(1);
    await run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "after disconnect" }));
    await pump(jobCtx.ctx);
    expect(g.eventList()[0]!.summary).not.toBe("after disconnect");
  });
});

describe("tenancy", () => {
  it("a connection in one organization never receives another organization's tasks, and cross-org job payloads are inert", async () => {
    const xconn = await connectUser("xann", X);
    const t = await mkTask({ primaryAssigneeId: u.ann!.id });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(0);
    await enqueue(c.admin, { kind: "calendar.sync_task", orgId: O.org.id, payload: { connectionId: xconn.id, taskId: t.id }, runAt: new Date(0) });
    await pump(jobCtx.ctx);
    expect(g.eventList()).toHaveLength(0);
    await c.admin.delete(calendarConnections).where(eq(calendarConnections.id, xconn.id));
  });

  it("a user in two organizations has independent connections", async () => {
    await addMember(c.admin, X.org.id, u.ann!.id, { role: "member" });
    const a = await connectUser("ann"); const b = await connectUser("ann", X);
    expect(a.id).not.toBe(b.id);
    expect(eventIdFor(a.id, "t")).not.toBe(eventIdFor(b.id, "t"));
    await c.admin.delete(calendarConnections).where(eq(calendarConnections.id, b.id));
  });

  it("event ids are deterministic, valid for Google (base32hex, 5-1024 chars) and differ per connection/task", () => {
    const id = eventIdFor("conn-1", "task-1");
    expect(id).toMatch(/^[0-9a-v]{32}$/);
    expect(eventIdFor("conn-1", "task-1")).toBe(id);
    expect(eventIdFor("conn-1", "task-2")).not.toBe(id);
    expect(eventIdFor("conn-2", "task-1")).not.toBe(id);
  });
});
