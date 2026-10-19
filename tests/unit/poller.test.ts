import { describe, expect, it } from "vitest";
import { DEFAULTS, nextStep, runPoller } from "../../scripts/poller.mjs";

const ok = () => Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });

describe("poller schedule", () => {
  it("does the full pass first, then the fast one, and the full one again once a minute has passed", () => {
    expect(nextStep({ now: 1000, lastFullAt: null, fullEveryMs: 60_000, intervalMs: 1000, failures: 0 })).toEqual({ full: true, wait: 1000 });
    expect(nextStep({ now: 2000, lastFullAt: 1000, fullEveryMs: 60_000, intervalMs: 1000, failures: 0 }).full).toBe(false);
    expect(nextStep({ now: 60_999, lastFullAt: 1000, fullEveryMs: 60_000, intervalMs: 1000, failures: 0 }).full).toBe(false);
    expect(nextStep({ now: 61_000, lastFullAt: 1000, fullEveryMs: 60_000, intervalMs: 1000, failures: 0 }).full).toBe(true);
  });

  it("waits longer after errors, up to a limit, and goes back to the normal pace after a success", () => {
    const wait = (failures: number) => nextStep({ now: 0, lastFullAt: 0, fullEveryMs: 60_000, intervalMs: 1000, failures }).wait;
    expect([0, 1, 2, 3, 4, 5, 9].map(wait)).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]);
  });
});

describe("runPoller", () => {
  const run = (o: Partial<Parameters<typeof runPoller>[0]> & { statuses?: (number | "throw")[] }) => {
    const seen: { url: string; auth: string | undefined }[] = [];
    const waits: number[] = [];
    let t = 0;
    const statuses = [...(o.statuses ?? [])];
    return {
      seen, waits,
      done: runPoller({
        secret: "s3cret", maxLoops: 4, ...o,
        clock: () => t,
        sleep: (ms) => { waits.push(ms); t += ms; return Promise.resolve(); },
        log: () => undefined,
        fetchImpl: (url, init) => {
          seen.push({ url, auth: init.headers.authorization });
          const next = statuses.shift();
          if (next === "throw") return Promise.reject(new Error("connection refused"));
          if (typeof next === "number") return Promise.resolve({ ok: next < 400, status: next, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
          return ok();
        },
      }),
    };
  };

  it("sends the secret as a bearer token, full pass first and fast passes after it, one request at a time", async () => {
    const r = run({ url: "http://127.0.0.1:3000/", maxLoops: 3 });
    const calls = await r.done;
    expect(r.seen.map((c) => c.url)).toEqual(["http://127.0.0.1:3000/api/cron/tick", "http://127.0.0.1:3000/api/cron/tick?fast=1", "http://127.0.0.1:3000/api/cron/tick?fast=1"]);
    expect(r.seen.every((c) => c.auth === "Bearer s3cret")).toBe(true);
    expect(calls.map((c) => c.status)).toEqual([200, 200, 200]);
    expect(r.waits).toEqual([1000, 1000, 1000]);
  });

  it("is a full pass again after a minute of fast ones", async () => {
    const r = run({ maxLoops: 62, intervalMs: 1000, fullEveryMs: 60_000 });
    await r.done;
    expect(r.seen.filter((c) => !c.url.includes("fast=1"))).toHaveLength(2); // the first, and the one 60 s later
    expect(r.seen.findIndex((c, i) => i > 0 && !c.url.includes("fast=1"))).toBe(60);
  });

  it("keeps going after an error or a refusal, backing off, and does not count a failed full pass as done", async () => {
    const r = run({ maxLoops: 4, statuses: ["throw", 401, 200, 200] });
    const calls = await r.done;
    expect(calls.map((c) => c.status)).toEqual([0, 401, 200, 200]);
    expect(r.seen.map((c) => c.url.includes("fast=1"))).toEqual([false, false, false, true]); // full pass repeated until one succeeded
    expect(r.waits).toEqual([2000, 4000, 1000, 1000]);
  });

  it("will not start without a secret, and never goes faster than 250 ms", async () => {
    await expect(runPoller({ secret: "", maxLoops: 1 })).rejects.toThrow(/CRON_SECRET/);
    const r = run({ maxLoops: 2, intervalMs: 10 });
    await r.done;
    expect(r.waits[0]).toBe(DEFAULTS.minIntervalMs);
  });

  it("stops when told to", async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(await run({ maxLoops: 100, signal: aborted.signal }).done).toEqual([]); // told before it began: it makes no call
    const ac = new AbortController();
    const r = run({ maxLoops: 100, signal: ac.signal, statuses: [200, 200] });
    const first = r.done;
    ac.abort(); // told while running: it finishes the call in flight and stops, instead of waiting out the sleep
    expect((await first).length).toBe(1);
  });
});
