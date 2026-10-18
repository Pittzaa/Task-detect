import { describe, expect, it, vi } from "vitest";
import { SignalHub, type SignalTokens } from "@/ui/signals";

/** A hub with a manual clock, a controllable network and a controllable tab visibility. */
function setup(opts: { interval?: number } = {}) {
  let now = 0;
  let visible = true;
  const timers = new Map<number, { at: number; fn: () => void }>();
  let nextId = 1;
  const calls: string[] = [];
  let responses: (() => Promise<SignalTokens>)[] = [];
  let fallback: SignalTokens = { tasks: "a", notifications: "n" };
  let fail = false;
  const hub = new SignalHub(
    async (url) => {
      calls.push(url);
      if (fail) throw new Error("offline");
      const next = responses.shift();
      return next ? next() : { ...fallback };
    },
    {
      visible: () => visible,
      now: () => now,
      setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
      clearTimeout: (id) => { timers.delete(id as number); },
      random: () => 0,
    },
    opts.interval ?? 1000,
    16_000,
  );
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].fn();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    now = end;
    await Promise.resolve(); await Promise.resolve();
  };
  return {
    hub, calls, advance, timers,
    setVisible: (v: boolean) => { visible = v; },
    setTokens: (t: SignalTokens) => { fallback = t; },
    setFail: (f: boolean) => { fail = f; },
    queue: (r: () => Promise<SignalTokens>) => { responses = [...responses, r]; },
  };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("SignalHub", () => {
  it("fetches once on subscribe, shares the request between subscribers of the same address, and tells everybody about a change", async () => {
    const s = setup();
    const a = vi.fn(), b = vi.fn();
    const offA = s.hub.subscribe("/x", a);
    const offB = s.hub.subscribe("/x", b);
    await flush();
    expect(s.calls).toEqual(["/x"]);
    expect(s.hub.snapshot("/x")).toEqual({ tasks: "a", notifications: "n" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    await s.advance(1000);
    expect(s.calls).toHaveLength(2);
    expect(a).toHaveBeenCalledTimes(1); // same tokens: nobody is woken up

    s.setTokens({ tasks: "b", notifications: "n" });
    await s.advance(1000);
    expect(a).toHaveBeenCalledTimes(2);
    expect(s.hub.snapshot("/x").tasks).toBe("b");
    offA(); offB();
  });

  it("keeps the snapshot object stable until a token really changes (useSyncExternalStore requires it)", async () => {
    const s = setup();
    s.hub.subscribe("/x", () => undefined);
    await flush();
    const first = s.hub.snapshot("/x");
    await s.advance(3000);
    expect(s.hub.snapshot("/x")).toBe(first);
  });

  it("leaving and coming straight back (navigation, remount, re-render churn) does not send a new request or lose the tokens", async () => {
    const s = setup();
    const off = s.hub.subscribe("/x", () => undefined);
    await flush();
    const tokens = s.hub.snapshot("/x");
    off();
    expect(s.hub.snapshot("/x")).toEqual(tokens); // still known for a moment
    for (let i = 0; i < 20; i++) { s.hub.subscribe("/x", () => undefined)(); } // churn
    const stay = s.hub.subscribe("/x", () => undefined);
    await flush();
    expect(s.calls).toHaveLength(1);
    await s.advance(1000);
    expect(s.calls).toHaveLength(2); // the normal rhythm resumes
    stay();
    await s.advance(5000); // away for longer than an interval: a fresh start asks again
    s.hub.subscribe("/x", () => undefined);
    await flush();
    expect(s.calls).toHaveLength(3);
  });

  it("different addresses poll independently", async () => {
    const s = setup();
    s.hub.subscribe("/x", () => undefined);
    s.hub.subscribe("/x?task=1", () => undefined);
    await flush();
    expect(s.calls.sort()).toEqual(["/x", "/x?task=1"]);
  });

  it("stops polling when the last subscriber leaves, and starts again for a new one", async () => {
    const s = setup();
    const off = s.hub.subscribe("/x", () => undefined);
    await flush();
    off();
    expect(s.timers.size).toBe(0);
    await s.advance(10_000);
    expect(s.calls).toHaveLength(1);
    s.hub.subscribe("/x", () => undefined);
    await flush();
    expect(s.calls).toHaveLength(2);
  });

  it("does not send requests while the tab is hidden, and catches up as soon as it is shown", async () => {
    const s = setup();
    s.hub.subscribe("/x", () => undefined);
    await flush();
    s.setVisible(false);
    await s.advance(10_000);
    expect(s.calls).toHaveLength(1);
    s.setVisible(true);
    s.hub.kick();
    await flush();
    expect(s.calls).toHaveLength(2);
  });

  it("backs off exponentially after errors, capped, and recovers on the first success", async () => {
    const s = setup({ interval: 1000 });
    s.hub.subscribe("/x", () => undefined);
    await flush();
    s.setFail(true);
    const times: number[] = [];
    const base = s.calls.length;
    for (let t = 0; t < 120_000; t += 500) {
      const before = s.calls.length;
      await s.advance(500);
      if (s.calls.length > before) times.push(t);
    }
    const gaps = times.slice(1).map((x, i) => x - times[i]!);
    expect(s.calls.length - base).toBeLessThan(15); // ~120 s of failures is nowhere near 120 requests
    expect(Math.max(...gaps)).toBeLessThanOrEqual(16_500); // capped
    expect(gaps[gaps.length - 1]!).toBeGreaterThanOrEqual(8000); // and grown
    s.setFail(false);
    await s.advance(17_000);
    const calls = s.calls.length;
    await s.advance(1100);
    expect(s.calls.length).toBe(calls + 1); // back to the normal 1 s rhythm
  });

  it("never has two requests in flight for one address", async () => {
    const s = setup();
    let release: (t: SignalTokens) => void = () => undefined;
    s.queue(() => new Promise<SignalTokens>((r) => { release = r; }));
    s.hub.subscribe("/x", () => undefined);
    s.hub.kick(); s.hub.kick(); s.hub.kick();
    await flush();
    expect(s.calls).toHaveLength(1);
    release({ tasks: "z" });
    await flush();
    expect(s.hub.snapshot("/x").tasks).toBe("z");
  });

  it("ignores a reply that arrives after everyone has left", async () => {
    const s = setup();
    let release: (t: SignalTokens) => void = () => undefined;
    s.queue(() => new Promise<SignalTokens>((r) => { release = r; }));
    const l = vi.fn();
    const off = s.hub.subscribe("/x", l);
    await flush();
    off();
    release({ tasks: "late" });
    await flush();
    expect(l).not.toHaveBeenCalled();
    expect(s.timers.size).toBe(0);
  });
});
