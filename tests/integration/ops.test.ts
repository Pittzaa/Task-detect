import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { enableRlsGuard } from "@/db/rls-guard";
import { withTenant } from "@/data/tenant";
import { withWorker } from "@/jobs/context";
import { hasNul, requestIdFor } from "@/server/api";
import { AppError } from "@/lib/errors";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());
afterEach(() => enableRlsGuard(false));

describe("row-level-security startup guard", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let user: { id: string };
  beforeAll(async () => {
    O = await makeOrg(c.admin, "GuardOrg");
    user = await makeUser(c.admin, "guard");
    await addMember(c.admin, O.org.id, user.id, { role: "orgadmin" });
  });

  it("is off by default (fixtures and tests may use a privileged connection)", async () => {
    await expect(withWorker(c.admin, async () => "ran")).resolves.toBe("ran");
  });

  it("when on, refuses to serve tenant or worker work through a role that bypasses row-level security", async () => {
    enableRlsGuard(true);
    const t = await withTenant(c.admin, { userId: user.id, orgId: O.org.id }, async () => "served").catch((e) => e);
    expect(t).toBeInstanceOf(AppError);
    expect(t).toMatchObject({ code: "UNAVAILABLE", status: 503 });
    const w = await withWorker(c.admin, async () => "served").catch((e) => e);
    expect(w).toMatchObject({ code: "UNAVAILABLE", status: 503 });
  });

  it("when on, serves normally through the least-privilege runtime role", async () => {
    enableRlsGuard(true);
    await expect(withTenant(c.app, { userId: user.id, orgId: O.org.id }, async (s) => s.orgId)).resolves.toBe(O.org.id);
    await expect(withWorker(c.app, async () => "ok")).resolves.toBe("ok");
  });
});

describe("request ids", () => {
  const req = (id?: string) => new Request("http://localhost/api/x", { headers: id === undefined ? {} : { "x-request-id": id } });

  it("keeps a harmless caller-supplied id so a request can be traced across systems", () => {
    expect(requestIdFor(req("trace-1234abcd"))).toBe("trace-1234abcd");
  });

  it("replaces anything that could forge log lines or is absurdly long", () => {
    for (const bad of ["short", "has space in it 12345", "x".repeat(65), "<script>alert(1)</script>", "../../etc/passwd"]) {
      const out = requestIdFor(req(bad));
      expect(out).not.toBe(bad);
      expect(out).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("generates a unique id when none is supplied", () => {
    expect(requestIdFor(req())).not.toBe(requestIdFor(req()));
  });
});

describe("NUL characters are rejected at the boundary (PostgreSQL cannot store them)", () => {
  it("finds a NUL anywhere in a JSON value: strings, keys, arrays, deep nesting", () => {
    expect(hasNul("a\u0000b")).toBe(true);
    expect(hasNul({ title: "ok", nested: { list: ["fine", "x\u0000"] } })).toBe(true);
    expect(hasNul({ ["k\u0000ey"]: 1 })).toBe(true);
    let deep: unknown = "\u0000";
    for (let i = 0; i < 50_000; i++) deep = [deep];
    expect(hasNul(deep)).toBe(true); // iterative: no stack overflow on hostile nesting
    // a long flat array (still under the 1 MB body cap) must not overflow the stack either: this once answered 500
    expect(hasNul(new Array(300_000).fill(0))).toBe(false);
    expect(hasNul([...new Array(300_000).fill(0), "x\u0000"])).toBe(true);
  });
  it("leaves ordinary text alone, including unicode, emoji and control characters other than NUL", () => {
    expect(hasNul({ a: "สวัสดี 🌏\n\t\u0001", b: [1, true, null, { c: "x" }] })).toBe(false);
    expect(hasNul(42)).toBe(false);
    expect(hasNul(null)).toBe(false);
  });
});
