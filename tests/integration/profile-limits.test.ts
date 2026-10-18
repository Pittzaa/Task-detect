import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { users } from "@/db/schema";
import { Client, PASSWORD, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { connect } from "./helpers";

const c = connect();
afterAll(() => c.close());

const BAD = "bad status";
const nameOf = async (email: string) => (await c.admin.select({ name: users.name }).from(users).where(eq(users.email, email)))[0]?.name;

describe("display names are bounded on every path that can write them", () => {
  it("Better Auth's own update-user cannot set a name the application's profile form would refuse", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { client, email } = await registerAndSignIn(app, "namelimit");
    for (const name of ["A".repeat(101), "A".repeat(100_000), "   ", "", "line one\nline two", "tab\there", "bidi ‮ evil", "nul\u0000byte"]) {
      const res = await client.authCall("POST", "/update-user", { name });
      expect(res.status, JSON.stringify(name).slice(0, 30)).toBeGreaterThanOrEqual(400);
      expect(res.status, BAD).toBeLessThan(500);
    }
    expect(await nameOf(email)).toBe("namelimit");
    expect((await client.authCall("POST", "/update-user", { name: "  Ana Bee  " })).status).toBe(200);
    expect(await nameOf(email)).toBe("Ana Bee"); // trimmed, like PATCH /api/me
    expect((await client.authCall("POST", "/update-user", { name: "ก".repeat(100) })).status).toBe(200);
  });

  it("sign-up refuses them too, so no unreviewed text reaches the verification e-mail", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const c1 = new Client(app.auth);
    const before = app.email.sent.length;
    for (const name of ["A".repeat(101), "x\ny", ""]) {
      const res = await c1.authCall("POST", "/sign-up/email", { email: `n-${Math.random().toString(36).slice(2, 8)}@example.test`, password: PASSWORD, name });
      expect(res.status, JSON.stringify(name).slice(0, 20)).toBeGreaterThanOrEqual(400);
      expect(res.status, BAD).toBeLessThan(500);
    }
    expect(app.email.sent.length).toBe(before);
    const ok = await c1.authCall("POST", "/sign-up/email", { email: `n-${Math.random().toString(36).slice(2, 8)}@example.test`, password: PASSWORD, name: "Ana" });
    expect(ok.status).toBe(200);
  });

  it("the profile picture field cannot be used to store bulk text either", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { client } = await registerAndSignIn(app, "imagelimit");
    const res = await client.authCall("POST", "/update-user", { image: "https://x.example/" + "a".repeat(5000) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status, BAD).toBeLessThan(500);
    expect((await client.authCall("POST", "/update-user", { image: "https://x.example/me.png" })).status).toBe(200);
  });
});

describe("names handed over by Google are cleaned, not refused", () => {
  it("strips control and bidi characters, collapses spaces, truncates, and falls back to the e-mail name", async () => {
    const { cleanProviderName } = await import("@/server/auth");
    expect(cleanProviderName("  Ana ‮ Bee\n", "ana@example.com")).toBe("Ana Bee");
    expect(cleanProviderName("x".repeat(500), "ana@example.com")).toHaveLength(100);
    expect(cleanProviderName("", "ana@example.com")).toBe("ana");
    expect(cleanProviderName(undefined, "ana@example.com")).toBe("ana");
    expect(cleanProviderName("‮\n", "bob@example.com")).toBe("bob");
  });
});
