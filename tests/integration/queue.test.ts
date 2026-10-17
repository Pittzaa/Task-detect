import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { jobs } from "@/db/schema";
import { backoffSeconds, claimJobs, completeJob, enqueue, failJob, queueStats } from "@/jobs/queue";
import { Deferred, PermanentFailure, runWorker, type JobContext, type Registry } from "@/jobs/worker";
import { createCaptureSender } from "@/integrations/email";
import { connect } from "./helpers";

const c = connect();
afterAll(() => c.close());

const ctxAt = (now: () => Date): JobContext => ({ db: c.app, email: createCaptureSender(), appUrl: "http://localhost:3000", encryptionKeys: [], fetchImpl: fetch, now });
const T0 = new Date("2026-06-10T10:00:00Z");
const at = (secs: number) => new Date(T0.getTime() + secs * 1000);
let kind = "";

beforeEach(async () => {
  kind = "test." + Math.random().toString(36).slice(2, 8);
});

const enq = (o: Partial<Parameters<typeof enqueue>[1]> = {}) => enqueue(c.admin, { kind, runAt: T0, ...o });
const row = async () => (await c.admin.select().from(jobs).where(eq(jobs.kind, kind)))[0]!;

describe("backoff", () => {
  it("doubles from 30s up to one hour with bounded jitter", () => {
    expect(backoffSeconds(1, 0)).toBe(30);
    expect(backoffSeconds(2, 0)).toBe(60);
    expect(backoffSeconds(3, 0)).toBe(120);
    expect(backoffSeconds(20, 0)).toBe(3600);
    expect(backoffSeconds(3, 1)).toBe(144);
    expect(backoffSeconds(0, 0)).toBe(30);
  });
});

describe("enqueue", () => {
  it("is idempotent for a dedupe key", async () => {
    const key = "dedupe-" + kind;
    expect((await enq({ dedupeKey: key })).created).toBe(true);
    expect((await enq({ dedupeKey: key })).created).toBe(false);
    expect((await c.admin.select().from(jobs).where(eq(jobs.dedupeKey, key)))).toHaveLength(1);
  });
  it("jobs without a key are independent", async () => {
    await enq(); await enq();
    expect((await c.admin.select().from(jobs).where(eq(jobs.kind, kind)))).toHaveLength(2);
  });
});

describe("claiming", () => {
  it("only claims jobs that are due and stamps a lease", async () => {
    await enq({ runAt: at(100) });
    expect((await claimJobs(c.app, { limit: 10, leaseSeconds: 60, workerId: "a", now: at(0), kinds: [kind] })).filter((j) => j.kind === kind)).toHaveLength(0);
    const got = (await claimJobs(c.app, { limit: 10, leaseSeconds: 60, workerId: "a", now: at(100), kinds: [kind] })).filter((j) => j.kind === kind);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ status: "running", attempts: 1, lockedBy: "a" });
    expect(got[0]!.lockedUntil!.getTime()).toBe(at(160).getTime());
  });

  it("concurrent workers never claim the same job", async () => {
    for (let i = 0; i < 12; i++) await enq();
    const claims = await Promise.all(["a", "b", "c", "d"].map((w) => claimJobs(c.app, { limit: 5, leaseSeconds: 60, workerId: w, now: at(0), kinds: [kind] })));
    const mine = claims.flat().filter((j) => j.kind === kind);
    expect(mine).toHaveLength(12);
    expect(new Set(mine.map((j) => j.id)).size).toBe(12);
  });

  it("re-claims a job whose worker died (lease expired) until attempts run out, then parks it as dead", async () => {
    await enq({ maxAttempts: 2 });
    expect((await claimJobs(c.app, { limit: 5, leaseSeconds: 10, workerId: "a", now: at(0), kinds: [kind] })).some((j) => j.kind === kind)).toBe(true);
    expect((await claimJobs(c.app, { limit: 5, leaseSeconds: 10, workerId: "b", now: at(5), kinds: [kind] })).some((j) => j.kind === kind)).toBe(false); // lease still valid
    const again = (await claimJobs(c.app, { limit: 5, leaseSeconds: 10, workerId: "b", now: at(11), kinds: [kind] })).filter((j) => j.kind === kind);
    expect(again[0]).toMatchObject({ attempts: 2, lockedBy: "b" });
    expect((await claimJobs(c.app, { limit: 5, leaseSeconds: 10, workerId: "c", now: at(30), kinds: [kind] })).some((j) => j.kind === kind)).toBe(false);
    expect(await row()).toMatchObject({ status: "dead", lastError: "lease_expired_attempts_exhausted" });
  });

  it("a slow worker cannot overwrite the result of the worker that re-claimed the job", async () => {
    await enq();
    const [first] = (await claimJobs(c.app, { limit: 5, leaseSeconds: 10, workerId: "slow", now: at(0), kinds: [kind] })).filter((j) => j.kind === kind);
    const [second] = (await claimJobs(c.app, { limit: 5, leaseSeconds: 10, workerId: "fast", now: at(20), kinds: [kind] })).filter((j) => j.kind === kind);
    expect(await completeJob(c.app, second!, at(21))).toBe(true);
    expect(await completeJob(c.app, first!, at(22))).toBe(false);
    expect(await failJob(c.app, first!, "Late", { now: at(23) })).toBe("retry");
    expect((await row()).status).toBe("succeeded");
  });
});

describe("worker", () => {
  const run = (registry: Registry, now: () => Date, o: Parameters<typeof runWorker>[2] = {}) => runWorker(ctxAt(now), registry, { maxMs: 5000, ...o });

  it("runs a handler and records success", async () => {
    await enq(); let calls = 0;
    const s = await run({ [kind]: async () => { calls++; } }, () => at(0));
    expect(calls).toBe(1);
    expect(s.succeeded).toBeGreaterThanOrEqual(1);
    expect(await row()).toMatchObject({ status: "succeeded", lastError: null });
  });

  it("retries with backoff, then dies after max attempts; the stored error holds no message text", async () => {
    await enq({ maxAttempts: 3 });
    const failing: Registry = { [kind]: async () => { throw Object.assign(new Error("SECRET-TOKEN abc123 leaked in message"), { status: 503 }); } };
    let t = 0;
    await run(failing, () => at(t));
    let r = await row();
    expect(r).toMatchObject({ status: "pending", attempts: 1 });
    expect(r.lastError).toBe("Error:503");
    expect(r.lastError).not.toContain("SECRET");
    expect(r.runAt.getTime()).toBeGreaterThanOrEqual(at(30).getTime());
    t = 100; await run(failing, () => at(t));
    expect((await row()).attempts).toBe(2);
    t = 400; await run(failing, () => at(t));
    r = await row();
    expect(r).toMatchObject({ status: "dead", attempts: 3 });
    t = 100000; await run(failing, () => at(t));
    expect((await row()).attempts).toBe(3); // dead jobs are never retried
  });

  it("a permanent failure goes straight to dead", async () => {
    await enq();
    await run({ [kind]: async () => { throw new PermanentFailure("BadConfig"); } }, () => at(0));
    expect(await row()).toMatchObject({ status: "dead", lastError: "BadConfig", attempts: 1 });
  });

  it("deferral reschedules without consuming an attempt", async () => {
    await enq();
    await run({ [kind]: async () => { throw new Deferred(at(3600), "quiet_hours"); } }, () => at(0));
    const r = await row();
    expect(r).toMatchObject({ status: "pending", attempts: 0, lastError: "quiet_hours" });
    expect(r.runAt.getTime()).toBe(at(3600).getTime());
  });

  it("a worker leaves job kinds it does not know untouched, so a newer worker can still run them", async () => {
    await enq();
    await run({ "some.other.kind": async () => {} }, () => at(0));
    expect(await row()).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("a hung handler is cut off by the timeout and retried", async () => {
    await enq();
    await run({ [kind]: () => new Promise(() => {}) }, () => at(0), { jobTimeoutMs: 50 });
    expect(await row()).toMatchObject({ status: "pending", lastError: "Error" });
  });

  it("re-running after a crash between handler success and completion repeats the handler (so handlers must be idempotent)", async () => {
    await enq();
    let calls = 0;
    const [claimed] = (await claimJobs(c.app, { limit: 5, leaseSeconds: 10, workerId: "crashy", now: at(0), kinds: [kind] })).filter((j) => j.kind === kind);
    void claimed; // simulates a worker that ran the handler then died before completeJob
    await run({ [kind]: async () => { calls++; } }, () => at(20));
    expect(calls).toBe(1);
    expect((await row()).attempts).toBe(2);
  });

  it("reports queue health including stuck and dead jobs", async () => {
    await enq({ runAt: at(-600) }); // will be claimed, then its lease lapses => "stuck"
    await enq({ runAt: at(-300) }); // waiting for 5 minutes => oldest pending
    await claimJobs(c.app, { limit: 1, leaseSeconds: 1, workerId: "x", now: at(-500), kinds: [kind] }); // leaves a lease that expired long ago
    const s = await queueStats(c.app, at(0));
    expect(s.pending).toBeGreaterThanOrEqual(1);
    expect(s.oldestPendingSeconds).toBeGreaterThanOrEqual(300);
    expect(s.stuck).toBeGreaterThanOrEqual(1);
  });

  it("tenant sessions cannot read or modify global jobs or other orgs' jobs", async () => {
    await enq();
    const visible = await c.app.select().from(jobs).where(eq(jobs.kind, kind));
    expect(visible).toHaveLength(0); // no worker flag, no org context => RLS hides them
    const touched = (await c.app.execute(sql`update jobs set status = 'dead' where kind = ${kind} returning id`)) as unknown as { rows: unknown[] };
    expect(touched.rows).toHaveLength(0);
  });
});
