import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { setProjectTeams } from "@/data/structure";
import { changeStatus, createTask, deleteTask, setAssignees } from "@/data/tasks";
import { updateSettings } from "@/data/notifications";
import { createDestination, deleteDestination, jobHealth, listDestinations, rotateDestination, updateDestination } from "@/data/integrations";
import { AppError } from "@/lib/errors";
import { deliveryAttempts, integrationDestinations, jobs, users } from "@/db/schema";
import { remindersScan } from "@/jobs/handlers/reminders";
import type { JobRow } from "@/jobs/queue";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { KEY, clearOutbox, makeJobCtx, pump } from "./jobs-helpers";

const c = connect();
afterAll(() => c.close());
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };

const ID = "123456789012345678";
const url = (token: string) => `https://discord.com/api/webhooks/${ID}/${token}`;
const TOKEN_A = "A".repeat(30) + "token-for-A-xyz";
const TOKEN_B = "B".repeat(30) + "token-for-B-xyz";
const deps = { encryptionKeys: [KEY] };

let O: Awaited<ReturnType<typeof makeOrg>>; let X: Awaited<ReturnType<typeof makeOrg>>; let P2: { id: string };
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: O.org.id }, fn);

interface Call { url: string; body: { content: string; allowed_mentions: unknown }; redirect?: string }
function fakeDiscord(responder: (call: Call, n: number) => Response = () => new Response(null, { status: 204 })) {
  const calls: Call[] = [];
  const f = (async (u: string, init: RequestInit) => {
    const call = { url: String(u), body: JSON.parse(init.body as string), redirect: init.redirect };
    calls.push(call);
    return responder(call, calls.length);
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

beforeAll(async () => {
  O = await makeOrg(c.admin, "DiscordOrg"); X = await makeOrg(c.admin, "DiscordOther");
  for (const k of ["admin", "mgr", "mem", "xadmin"]) u[k] = await makeUser(c.admin, k);
  await c.admin.update(users).set({ locale: "en" }).where(eq(users.id, u.mem!.id));
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, O.org.id, u.mem!.id, { role: "member" });
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
  await run("admin", (s) => setProjectTeams(s, O.project.id, [O.team.id]));
  const r = (await c.admin.execute(`insert into projects (org_id, name) values ('${O.org.id}', 'Other project') returning id` as never)) as unknown as { rows: { id: string }[] };
  P2 = r.rows[0]!;
  await clearOutbox(c.admin);
});

const mkDest = (over: Partial<Parameters<typeof createDestination>[2]> = {}) =>
  run("admin", (s) => createDestination(s, deps, { name: "Dev channel", webhookUrl: url(TOKEN_A), projectId: O.project.id, events: ["task.assigned", "task.status_changed"], ...over }));
const mkTask = (over: Partial<Parameters<typeof createTask>[1]> = {}) => run("mgr", (s) => createTask(s, { projectId: O.project.id, title: "Ship feature", ...over }));
const destRow = async (id: string) => (await c.admin.select().from(integrationDestinations).where(eq(integrationDestinations.id, id)))[0]!;

describe("configuration and secret handling", () => {
  it("only org.manage_integrations holders can manage destinations", async () => {
    for (const k of ["mgr", "mem"]) {
      expect(await code(run(k, (s) => createDestination(s, deps, { name: "x", webhookUrl: url(TOKEN_A), projectId: O.project.id, events: ["task.assigned"] })))).toBe("FORBIDDEN");
      expect(await code(run(k, (s) => listDestinations(s)))).toBe("FORBIDDEN");
    }
  });

  it("validates input: URL shape, exactly one target, known events, targets within the org", async () => {
    const attempt = (over: Partial<Parameters<typeof createDestination>[2]>) => code(mkDest(over));
    expect(await attempt({ webhookUrl: "https://evil.example/api/webhooks/1/x" })).toBe("VALIDATION");
    expect(await attempt({ webhookUrl: url(TOKEN_A) + "?x=1" })).toBe("VALIDATION");
    expect(await attempt({ projectId: null, teamId: null })).toBe("VALIDATION");
    expect(await attempt({ projectId: O.project.id, teamId: O.team.id })).toBe("VALIDATION");
    expect(await attempt({ events: [] })).toBe("VALIDATION");
    expect(await attempt({ events: ["task.deleted"] })).toBe("VALIDATION");
    expect(await attempt({ name: " " })).toBe("VALIDATION");
    expect(await attempt({ projectId: X.project.id })).toBe("NOT_FOUND");
    expect(await attempt({ projectId: null, teamId: X.team.id })).toBe("NOT_FOUND");
  });

  it("stores the webhook encrypted; no API ever returns it; only a hint is shown", async () => {
    const { id } = await mkDest();
    const row = await destRow(id);
    expect(row.webhookCiphertext).not.toContain(TOKEN_A);
    expect(row.webhookCiphertext).not.toContain("discord.com");
    const list = await run("admin", (s) => listDestinations(s));
    const mine = list.find((d) => d.id === id)!;
    expect(mine.webhook).toBe("…-xyz".slice(0, 0) + "…" + TOKEN_A.slice(-4));
    expect(JSON.stringify(list)).not.toContain(TOKEN_A);
    expect(JSON.stringify(list)).not.toContain("Ciphertext");
    const audits = JSON.stringify((await c.admin.execute(`select metadata from audit_logs where target_id = '${id}'` as never)) as unknown);
    expect(audits).not.toContain(TOKEN_A);
  });

  it("is isolated per organization", async () => {
    const { id } = await mkDest();
    const other = { userId: u.xadmin!.id, orgId: X.org.id };
    expect((await withTenant(c.app, other, (s) => listDestinations(s))).map((d) => d.id)).not.toContain(id);
    expect(await code(withTenant(c.app, other, (s) => updateDestination(s, id, { enabled: false })))).toBe("NOT_FOUND");
    expect(await code(withTenant(c.app, other, (s) => deleteDestination(s, id)))).toBe("NOT_FOUND");
    expect(await code(withTenant(c.app, other, (s) => rotateDestination(s, deps, id, url(TOKEN_B))))).toBe("NOT_FOUND");
  });

  it("rotation replaces the secret and re-enables a disabled destination; delete is soft and stops delivery", async () => {
    const { id } = await mkDest();
    await c.admin.update(integrationDestinations).set({ enabled: false, disabledReason: "invalid_webhook", consecutiveFailures: 10 }).where(eq(integrationDestinations.id, id));
    const before = (await destRow(id)).webhookCiphertext;
    await run("admin", (s) => rotateDestination(s, deps, id, url(TOKEN_B)));
    const after = await destRow(id);
    expect(after.webhookCiphertext).not.toBe(before);
    expect(after).toMatchObject({ enabled: true, disabledReason: null, consecutiveFailures: 0 });
    expect(after.rotatedAt).toBeInstanceOf(Date);
    expect(await code(run("admin", (s) => rotateDestination(s, deps, id, "http://bad")))).toBe("VALIDATION");
    await run("admin", (s) => deleteDestination(s, id));
    expect((await run("admin", (s) => listDestinations(s))).map((d) => d.id)).not.toContain(id);
  });
});

describe("delivery", () => {
  // Destinations left over from other tests must not receive this test's events.
  beforeEach(async () => {
    await c.admin.update(integrationDestinations).set({ enabled: false, deletedAt: new Date() }).where(eq(integrationDestinations.orgId, O.org.id));
    await clearOutbox(c.admin);
  });

  it("posts a message with NO task details by default, with mentions disabled and an authenticated-only link", async () => {
    const { id } = await mkDest({ name: "Dev <@&role> channel" });
    const d = fakeDiscord();
    const { ctx } = makeJobCtx(c.app, { fetchImpl: d.fetch });
    const t = await mkTask({ title: "Project Falcon launch date", description: "internal budget numbers" });
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] }));
    await pump(ctx);
    const call = d.calls.find((x) => x.url === url(TOKEN_A) && x.body.content.includes("Dev"))!;
    expect(call).toBeTruthy();
    expect(call.body.content).not.toContain("Falcon");
    expect(call.body.content).not.toContain("budget");
    expect(call.body.content).not.toMatch(/<@/);
    expect(call.body.allowed_mentions).toEqual({ parse: [] });
    expect(call.redirect).toBe("error");
    expect(call.body.content).toContain(`/o/${O.org.id}/tasks?task=${t.id}`);
    expect((await destRow(id)).lastStatus).toBe("sent");
    expect((await c.admin.select().from(deliveryAttempts).where(eq(deliveryAttempts.subjectId, id))).some((a) => a.status === "sent")).toBe(true);
    await run("admin", (s) => deleteDestination(s, id));
  });

  it("includes the title only when an administrator explicitly enabled includeDetails, and neutralises markup/mentions in it", async () => {
    const { id } = await mkDest({ name: "DetailsHook", includeDetails: true, events: ["task.assigned"] });
    const d = fakeDiscord();
    const { ctx } = makeJobCtx(c.app, { fetchImpl: d.fetch });
    const t = await mkTask({ title: "@everyone **Release** `now`" });
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] }));
    await pump(ctx);
    const call = d.calls.find((x) => x.body.content.includes("[DetailsHook]"))!;
    expect(call.body.content).toContain("Release");
    expect(call.body.content).not.toMatch(/@everyone|\*\*|`/);
    await run("admin", (s) => deleteDestination(s, id));
  });

  it("only subscribed events are delivered, and one job per destination per event", async () => {
    const a = await mkDest({ name: "A", events: ["task.status_changed"] });
    const b = await mkDest({ name: "B", events: ["task.assigned"] });
    const d = fakeDiscord();
    const { ctx } = makeJobCtx(c.app, { fetchImpl: d.fetch });
    const t = await mkTask();
    await pump(ctx); // task.created is subscribed by neither
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] }));
    await pump(ctx);
    expect(d.calls.filter((x) => x.body.content.includes("[B]"))).toHaveLength(1);
    expect(d.calls.filter((x) => x.body.content.includes("[A]"))).toHaveLength(0);
    await run("mem", async (s) => { await changeStatus(s, t.id, "progress"); });
    await pump(ctx);
    expect(d.calls.filter((x) => x.body.content.includes("[A]"))).toHaveLength(1);
    await run("admin", async (s) => { await deleteDestination(s, a.id); await deleteDestination(s, b.id); });
  });

  it("team destinations receive events only for projects that team participates in", async () => {
    const teamDest = await mkDest({ name: "TeamHook", projectId: null, teamId: O.team.id, events: ["task.created"] });
    const d = fakeDiscord();
    const { ctx } = makeJobCtx(c.app, { fetchImpl: d.fetch });
    await run("admin", (s) => createTask(s, { projectId: P2.id, title: "unrelated project" }));
    await pump(ctx);
    expect(d.calls.filter((x) => x.body.content.includes("TeamHook"))).toHaveLength(0);
    await mkTask({ title: "shared project task" });
    await pump(ctx);
    expect(d.calls.filter((x) => x.body.content.includes("TeamHook"))).toHaveLength(1);
    await run("admin", (s) => deleteDestination(s, teamDest.id));
  });

  it("honours Discord rate limits: waits for retry-after without counting a failure, then delivers", async () => {
    const { id } = await mkDest({ events: ["task.created"] });
    const clock = { now: new Date() };
    let limited = true;
    const d = fakeDiscord(() => (limited ? new Response("{}", { status: 429, headers: { "retry-after": "7" } }) : new Response(null, { status: 204 })));
    const { ctx } = makeJobCtx(c.app, { fetchImpl: d.fetch, clock });
    await mkTask();
    await pump(ctx, 1);
    const [job] = await c.admin.select().from(jobs).where(and(eq(jobs.kind, "discord.send"), sql`${jobs.payload}->>'destinationId' = ${id}`));
    expect(job).toMatchObject({ status: "pending", attempts: 0, lastError: "discord_rate_limited" });
    expect(job!.runAt.getTime() - clock.now.getTime()).toBeGreaterThanOrEqual(6900);
    expect((await destRow(id)).consecutiveFailures).toBe(0);
    limited = false;
    clock.now = new Date(clock.now.getTime() + 10_000);
    await pump(ctx, 1);
    expect((await destRow(id)).lastStatus).toBe("sent");
    await run("admin", (s) => deleteDestination(s, id));
  });

  it("a deleted/revoked webhook (404) disables the destination, stops retries and stops future jobs; rotating fixes it", async () => {
    const { id } = await mkDest({ events: ["task.created"] });
    const d = fakeDiscord(() => new Response(null, { status: 404 }));
    const { ctx } = makeJobCtx(c.app, { fetchImpl: d.fetch });
    await mkTask();
    await pump(ctx);
    expect(await destRow(id)).toMatchObject({ enabled: false, disabledReason: "invalid_webhook" });
    const [job] = await c.admin.select().from(jobs).where(and(eq(jobs.kind, "discord.send"), sql`${jobs.payload}->>'destinationId' = ${id}`));
    expect(job).toMatchObject({ status: "dead", lastError: "InvalidWebhook" });
    const callsBefore = d.calls.length;
    await mkTask({ title: "second" });
    await pump(ctx);
    expect(d.calls.length).toBe(callsBefore); // disabled destinations get no jobs at all
    const ok = fakeDiscord();
    const { ctx: ctx2 } = makeJobCtx(c.app, { fetchImpl: ok.fetch });
    await run("admin", (s) => rotateDestination(s, deps, id, url(TOKEN_B)));
    await mkTask({ title: "third" });
    await pump(ctx2);
    expect(ok.calls.some((x) => x.url === url(TOKEN_B))).toBe(true);
    expect(ok.calls.some((x) => x.url === url(TOKEN_A))).toBe(false);
    await run("admin", (s) => deleteDestination(s, id));
  });

  it("repeated server errors retry with backoff and auto-disable after 10 consecutive failures", async () => {
    const { id } = await mkDest({ events: ["task.created"] });
    await c.admin.update(integrationDestinations).set({ consecutiveFailures: 9 }).where(eq(integrationDestinations.id, id));
    const d = fakeDiscord(() => new Response("oops", { status: 502 }));
    const clock = { now: new Date() };
    const { ctx } = makeJobCtx(c.app, { fetchImpl: d.fetch, clock });
    await mkTask();
    await pump(ctx, 1);
    expect(await destRow(id)).toMatchObject({ enabled: false, disabledReason: "too_many_failures", consecutiveFailures: 10 });
    const [job] = await c.admin.select().from(jobs).where(and(eq(jobs.kind, "discord.send"), sql`${jobs.payload}->>'destinationId' = ${id}`));
    expect(job!.lastError).toBe("Error:502");
    await run("admin", (s) => deleteDestination(s, id));
  });

  it("re-checks at send time: disabled destination, deleted task and out-of-scope task are all skipped", async () => {
    const dest = await mkDest({ name: "Recheck", events: ["task.created"] });
    const d = fakeDiscord();
    const { ctx } = makeJobCtx(c.app, { fetchImpl: d.fetch });
    // queue jobs but do not deliver yet
    const { outboxProcess } = await import("@/jobs/handlers/outbox");
    const t1 = await mkTask({ title: "will be deleted" });
    const t2 = await mkTask({ title: "stays but destination disabled" });
    await outboxProcess(ctx, {} as JobRow);
    await run("mgr", (s) => deleteTask(s, t1.id));
    await run("admin", (s) => updateDestination(s, dest.id, { enabled: false }));
    const { runWorker } = await import("@/jobs/worker");
    const { registry } = await import("@/jobs/registry");
    await runWorker(ctx, registry, { maxMs: 3000 });
    expect(d.calls.filter((x) => x.body.content.includes("Recheck"))).toHaveLength(0);
    const skips = await c.admin.select().from(deliveryAttempts).where(and(eq(deliveryAttempts.subjectId, dest.id), eq(deliveryAttempts.status, "skipped")));
    expect(skips.map((s) => s.detail).sort()).toEqual(["destination_unavailable", "destination_unavailable"]);
    void t2;
    // out of scope: a project destination whose task has moved is handled by the same guard; verify via direct job
    await run("admin", (s) => updateDestination(s, dest.id, { enabled: true }));
    const { enqueue } = await import("@/jobs/queue");
    const other = await run("admin", (s) => createTask(s, { projectId: P2.id, title: "other project" }));
    await enqueue(c.admin, { kind: "discord.send", orgId: O.org.id, payload: { destinationId: dest.id, taskId: other.id, event: "task.created" }, runAt: new Date(0) });
    await runWorker(ctx, registry, { maxMs: 3000 });
    expect(d.calls.filter((x) => x.body.content.includes("Recheck"))).toHaveLength(0);
    expect((await c.admin.select().from(deliveryAttempts).where(and(eq(deliveryAttempts.subjectId, dest.id), eq(deliveryAttempts.detail, "out_of_scope")))).length).toBe(1);
    await run("admin", (s) => deleteDestination(s, dest.id));
  });

  it("due-soon and overdue alerts reach subscribed destinations once", async () => {
    const dest = await mkDest({ name: "Alerts", events: ["task.overdue", "task.due_soon"] });
    const d = fakeDiscord();
    const { ctx, clock } = makeJobCtx(c.app, { fetchImpl: d.fetch });
    const t = await mkTask({ dueDate: "2026-04-01", primaryAssigneeId: u.mem!.id });
    clock.now = new Date("2026-04-03T05:00:00Z");
    await remindersScan(ctx, {} as JobRow);
    await remindersScan(ctx, {} as JobRow);
    await pump(ctx, 1);
    expect(d.calls.filter((x) => x.body.content.includes("[Alerts]") && x.body.content.includes(t.id))).toHaveLength(1);
    await run("admin", (s) => deleteDestination(s, dest.id));
  });
});

describe("alerts and the assignee's own notification choices", () => {
  it("a due-soon or overdue alert still reaches the destination when its only assignee has the bell off for it (their e-mail choice is the combined deadline e-mail)", async () => {
    const dest = await mkDest({ name: "Quiet bell", events: ["task.overdue"] });
    const who = await makeUser(c.admin, "nobell");
    await addMember(c.admin, O.org.id, who.id, { role: "member" });
    await withTenant(c.app, { userId: who.id, orgId: O.org.id }, (s) => updateSettings(s, { settings: [{ channel: "in_app", event: "task.overdue", enabled: false }] }));
    const d = fakeDiscord();
    const { ctx, clock } = makeJobCtx(c.app, { fetchImpl: d.fetch });
    const t = await mkTask({ dueDate: "2026-04-01", primaryAssigneeId: who.id });
    clock.now = new Date("2026-04-03T05:00:00Z");
    await remindersScan(ctx, {} as JobRow);
    await remindersScan(ctx, {} as JobRow); // the second scan changes nothing: the destination's job has a key
    await pump(ctx, 1);
    expect(d.calls.filter((x) => x.body.content.includes("[Quiet bell]") && x.body.content.includes(t.id))).toHaveLength(1);
    await run("admin", (s) => deleteDestination(s, dest.id));
  });
});

describe("operational visibility", () => {
  it("admins can see dead-job counts and error classes for their org, never payloads; others cannot", async () => {
    await c.admin.insert(jobs).values({ kind: "discord.send", orgId: O.org.id, status: "dead", lastError: "InvalidWebhook", payload: { destinationId: "x", webhookUrl: "SHOULD-NEVER-BE-HERE" } });
    const health = await run("admin", (s) => jobHealth(s));
    const entry = health.kinds.find((k) => k.kind === "discord.send")!;
    expect(entry.dead).toBeGreaterThanOrEqual(1);
    expect(entry.lastError).toBeTruthy();
    expect(JSON.stringify(health)).not.toContain("SHOULD-NEVER-BE-HERE");
    expect(await code(run("mgr", (s) => jobHealth(s)))).toBe("FORBIDDEN");
    const other = await withTenant(c.app, { userId: u.xadmin!.id, orgId: X.org.id }, (s) => jobHealth(s));
    expect(other.kinds.find((k) => k.kind === "discord.send")).toBeUndefined();
  });
});
