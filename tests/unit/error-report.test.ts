import { describe, expect, it, vi } from "vitest";
import { createReporter, describeError, parseDsn, reportError, setReporterForTests } from "@/lib/error-report";
import { getEnv } from "@/config/env";

const DSN = "https://abc123@o1.ingest.example.io/4501";

describe("describeError", () => {
  it("drops the bound parameters that database driver errors embed in their message", () => {
    const driver = Object.assign(new Error('insert or update on table "tasks" violates foreign key constraint "tasks_project_fk"'), { code: "23503", constraint: "tasks_project_fk", table: "tasks" });
    const wrapped = new Error('Failed query: insert into "tasks" ("title") values ($1)\nparams: Secret launch codes for ana@example.com', { cause: driver });
    const safe = describeError(wrapped);
    const text = JSON.stringify(safe);
    expect(text).not.toContain("launch codes");
    expect(text).not.toContain("ana@example.com");
    expect(safe.message).toBe("database error 23503: foreign key violation");
    expect(safe).toMatchObject({ code: "23503", constraint: "tasks_project_fk", table: "tasks" });
  });

  it("scrubs a parameter dump even when there is no wrapped cause", () => {
    const safe = describeError(new Error("Failed query: select * from users where email = $1\nparams: bob@example.com"));
    expect(JSON.stringify(safe)).not.toContain("bob@example.com");
    expect(safe.message).toBe("database query failed");
  });

  it("does not keep the text of database errors at all, because PostgreSQL quotes the offending value in it", () => {
    const driver = Object.assign(new Error('invalid input syntax for type uuid: "ana@example.com"'), { code: "22P02" });
    const safe = describeError(new Error("Failed query: select 1", { cause: driver }));
    expect(JSON.stringify(safe)).not.toContain("ana@example.com");
    expect(safe.message).toBe("database error 22P02: invalid text representation");
    // an operating-system error code is not a SQLSTATE: its message is kept
    expect(describeError(Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" })).message).toBe("EBUSY: resource busy");
  });

  it("cuts anything after a params: marker and bounds the length", () => {
    expect(describeError(new Error("boom\nparams: hunter2")).message).toBe("boom");
    expect(describeError(new Error("x".repeat(5000))).message.length).toBeLessThanOrEqual(300);
  });

  it("accepts values that are not errors", () => {
    expect(describeError("secret string").message).toBe("string thrown");
    expect(describeError({ a: 1 }).name).toBe("NonError");
    expect(describeError(undefined).message).toBe("unknown");
  });

  it("keeps only a few stack frames", () => {
    expect((describeError(new Error("x")).frames ?? []).length).toBeLessThanOrEqual(8);
  });
});

describe("parseDsn", () => {
  it("builds the envelope endpoint from an https DSN", () => {
    expect(parseDsn(DSN)).toEqual({ endpoint: "https://o1.ingest.example.io/api/4501/envelope/", key: "abc123" });
    expect(parseDsn("https://k@host.example/sentry/17")).toEqual({ endpoint: "https://host.example/sentry/api/17/envelope/", key: "k" });
  });
  it.each([
    undefined, "", "not a url", "http://k@host/1", "https://host/1", "https://k@host/", "https://k@host/abc", "ftp://k@host/1", "javascript:alert(1)",
  ])("rejects %s", (dsn) => { expect(parseDsn(dsn as string | undefined)).toBeNull(); });
});

describe("reporter", () => {
  const ctx = { kind: "api" as const, requestId: "req-1", method: "POST", path: "/api/orgs/x/tasks" };
  const err = { name: "Error", message: "boom" };

  it("does nothing, and never calls the network, without a DSN", async () => {
    const f = vi.fn();
    const r = createReporter({ fetchImpl: f as unknown as typeof fetch });
    expect(r.enabled).toBe(false);
    await r.report(err, ctx);
    expect(f).not.toHaveBeenCalled();
  });

  it("sends one Sentry envelope with the auth header and no request body, headers or cookies", async () => {
    const f = vi.fn(async () => new Response("{}"));
    const r = createReporter({ dsn: DSN, environment: "production", release: "abc", fetchImpl: f as unknown as typeof fetch });
    await r.report({ ...err, code: "23505" }, ctx);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://o1.ingest.example.io/api/4501/envelope/");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect((init.headers as Record<string, string>)["x-sentry-auth"]).toContain("sentry_key=abc123");
    const lines = String(init.body).split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[1]).toEqual({ type: "event" });
    const event = lines[2] as { environment: string; release: string; tags: Record<string, string>; request: Record<string, unknown>; exception: { values: { value: string }[] } };
    expect(event).toMatchObject({ environment: "production", release: "abc", tags: { kind: "api", request_id: "req-1", db_code: "23505" }, request: { method: "POST", url: "/api/orgs/x/tasks" } });
    expect(event.request).not.toHaveProperty("headers");
    expect(event.request).not.toHaveProperty("cookies");
    expect(event.request).not.toHaveProperty("data");
    expect(event.exception.values[0]!.value).toBe("boom");
  });

  it("sends an identical error only once per minute, and again after the window", async () => {
    let t = 1_000_000;
    const f = vi.fn(async () => new Response("{}"));
    const r = createReporter({ dsn: DSN, fetchImpl: f as unknown as typeof fetch, now: () => t });
    await r.report(err, ctx); await r.report(err, ctx); await r.report(err, ctx);
    expect(f).toHaveBeenCalledTimes(1);
    t += 61_000;
    await r.report(err, ctx);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("stops after the per-minute budget so an error storm cannot flood the tracker", async () => {
    const f = vi.fn(async () => new Response("{}"));
    const r = createReporter({ dsn: DSN, fetchImpl: f as unknown as typeof fetch, now: () => 5_000_000, maxPerMinute: 3 });
    for (let i = 0; i < 10; i++) await r.report({ name: "Error", message: `distinct ${i}` }, ctx);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("swallows delivery failures (the request that failed must not fail again because the tracker is down)", async () => {
    const r = createReporter({ dsn: DSN, fetchImpl: (async () => { throw new TypeError("network down"); }) as unknown as typeof fetch });
    await expect(r.report(err, ctx)).resolves.toBeUndefined();
  });
});

describe("reportError", () => {
  it("returns the redacted description and hands the delivery to the deferred hook only when enabled", async () => {
    const f = vi.fn(async () => new Response("{}"));
    setReporterForTests(createReporter({ dsn: DSN, fetchImpl: f as unknown as typeof fetch }));
    let deferred: Promise<unknown> | undefined;
    const safe = reportError(new Error("db exploded\nparams: pw=hunter2"), { kind: "job" }, (p) => { deferred = p; });
    expect(JSON.stringify(safe)).not.toContain("hunter2");
    await deferred;
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body)).not.toContain("hunter2");

    setReporterForTests(createReporter({ fetchImpl: f as unknown as typeof fetch }));
    let called = false;
    reportError(new Error("again"), { kind: "job" }, () => { called = true; });
    expect(called).toBe(false);
    setReporterForTests(undefined);
  });

  it("does not throw if the deferred hook is unavailable (called outside a request scope)", () => {
    setReporterForTests(createReporter({ dsn: DSN, fetchImpl: (async () => new Response("{}")) as unknown as typeof fetch }));
    expect(() => reportError(new Error("x"), { kind: "other" }, () => { throw new Error("outside a request scope"); })).not.toThrow();
    setReporterForTests(undefined);
  });
});

describe("SENTRY_DSN in the environment", () => {
  const base = { DATABASE_URL: "postgres://x", NODE_ENV: "production", APP_URL: "https://app.example", BETTER_AUTH_SECRET: "x".repeat(40), APP_ENCRYPTION_KEY: "k", RESEND_API_KEY: "r", EMAIL_FROM: "a@b.c", CRON_SECRET: "c".repeat(20) };
  it("is optional, blank counts as unset, and must be https in production", () => {
    expect(getEnv(base as unknown as NodeJS.ProcessEnv).SENTRY_DSN).toBeUndefined();
    expect(getEnv({ ...base, SENTRY_DSN: "" } as unknown as NodeJS.ProcessEnv).SENTRY_DSN).toBeUndefined();
    expect(getEnv({ ...base, SENTRY_DSN: DSN } as unknown as NodeJS.ProcessEnv).SENTRY_DSN).toBe(DSN);
    expect(() => getEnv({ ...base, SENTRY_DSN: "http://k@host/1" } as unknown as NodeJS.ProcessEnv)).toThrow(/SENTRY_DSN/);
  });
});
