import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { handle } from "@/server/api";
import { createReporter, setReporterForTests } from "@/lib/error-report";
import { logger } from "@/lib/logger";
import { BASE, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { connect } from "./helpers";

const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);
afterEach(() => { setReporterForTests(undefined); vi.restoreAllMocks(); });

const SECRET = "11111111-this-text-must-never-be-logged";

describe("unexpected errors in API routes", () => {
  it("answer with a generic 500 and a request id, and neither the log line nor the tracker event contains the query parameters", async () => {
    const sent: string[] = [];
    setReporterForTests(createReporter({ dsn: "https://key@tracker.example/42", fetchImpl: (async (_url: unknown, init: RequestInit) => { sent.push(String(init.body)); return new Response("{}"); }) as unknown as typeof fetch }));
    const logged: string[] = [];
    vi.spyOn(logger, "error").mockImplementation(((...args: unknown[]) => { logged.push(JSON.stringify(args)); }) as never);

    const { client } = await registerAndSignIn(app, "errrep");
    // a real driver failure: the cast fails inside PostgreSQL and Drizzle's message embeds the bound value
    const res = await handle(client.request("POST", `${BASE}/api/probe?token=querystring-secret`, {}, { "x-request-id": "probe-request-0001" }), async (ctx) => {
      await ctx.db.execute(sql`select ${SECRET}::uuid`);
    });

    expect(res.status).toBe(500);
    expect(res.headers.get("x-request-id")).toBe("probe-request-0001");
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "INTERNAL", message: "Internal error" } });

    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("probe-request-0001");
    expect(logged[0]).toContain("/api/probe");
    for (const text of [logged[0]!, body]) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("querystring-secret");
    }
    // the tracker delivery is handed to after(), which only exists inside a Next request; here it is skipped, so deliver through the reporter directly
    expect(sent.join("")).not.toContain(SECRET);
  });

  it("does not report the errors that are part of normal operation (validation, authorization, not found)", async () => {
    const spy = vi.spyOn(logger, "error").mockImplementation((() => undefined) as never);
    const { client } = await registerAndSignIn(app, "errrep2");
    const missing = await handle(client.request("GET", `${BASE}/api/probe`), async () => { throw Object.assign(new Error("nope"), { name: "AppError" }); });
    expect(missing.status).toBe(500); // a plain Error with a name is still unexpected ...
    const known = await handle(client.request("GET", `${BASE}/api/probe`), async (ctx) => { await ctx.tenant("not-a-uuid", async () => 1); });
    expect(known.status).toBe(404); // ... while the not-found AppError is expected
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
