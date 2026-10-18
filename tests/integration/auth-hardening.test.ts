import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { PATCH as mePATCH } from "@/app/api/me/route";
import { users } from "@/db/schema";
import { createAuth } from "@/server/auth";
import { createCaptureSender } from "@/integrations/email";
import { Client, PASSWORD, linkIn, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { connect } from "./helpers";

const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

describe("production cookies", () => {
  it("in a production tier the session cookie is Secure, HttpOnly, SameSite=Lax and carries the __Secure- prefix", async () => {
    const BASE = "https://tasks.example.test";
    const email = createCaptureSender();
    const auth = createAuth({ db: c.app, baseURL: BASE, secret: "prod-secret-prod-secret-prod-secret-0000", email, rateLimit: false, production: true });
    const address = `secure-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const post = (path: string, body: unknown) => auth.handler(new Request(`${BASE}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) }));
    expect((await post("/sign-up/email", { email: address, password: PASSWORD, name: "Secure" })).status).toBe(200);
    const mail = [...email.sent].reverse().find((m) => m.to === address)!;
    await auth.handler(new Request(linkIn(mail.text)));
    const res = await post("/sign-in/email", { email: address, password: PASSWORD });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().find((l) => /session_token/.test(l))!;
    expect(cookie).toMatch(/^__Secure-/);
    expect(cookie).toMatch(/;\s*Secure/i);
    expect(cookie).toMatch(/;\s*HttpOnly/i);
    expect(cookie).toMatch(/;\s*SameSite=Lax/i);
  });
});

describe("mass assignment on account endpoints", () => {
  it("sign-up ignores attempts to set privileged or verification fields", async () => {
    const cl = new Client(app.auth);
    const address = `mass-${Math.random().toString(36).slice(2, 8)}@example.test`;
    const res = await cl.authCall("POST", "/sign-up/email", {
      email: address, password: PASSWORD, name: "Mass", emailVerified: true, isPlatformAdmin: true, twoFactorEnabled: true, role: "admin", id: "00000000-0000-4000-8000-0000000000aa",
    });
    expect(res.status).toBeLessThan(500);
    const [row] = await c.admin.select().from(users).where(eq(users.email, address));
    if (row) {
      expect(row.emailVerified).toBe(false);
      expect(row.isPlatformAdmin).toBe(false);
      expect(row.twoFactorEnabled).toBeFalsy();
      expect(row.id).not.toBe("00000000-0000-4000-8000-0000000000aa");
    }
    // still cannot sign in without verifying the address
    expect((await cl.authCall("POST", "/sign-in/email", { email: address, password: PASSWORD })).status).toBe(403);
  });

  it("a signed-in user cannot grant themselves platform admin, mark an address verified, or swap their e-mail through the account endpoints", async () => {
    const { client, email } = await registerAndSignIn(app, "massupd");
    for (const body of [{ isPlatformAdmin: true }, { emailVerified: true }, { twoFactorEnabled: false }, { email: "someone-else@example.test" }, { id: "00000000-0000-4000-8000-0000000000bb" }]) {
      const r = await client.authCall("POST", "/update-user", body);
      expect(r.status, JSON.stringify(body)).toBeLessThan(500);
    }
    const change = await client.authCall("POST", "/change-email", { newEmail: "swapped@example.test" });
    expect(change.status).toBeLessThan(500);
    const [row] = await c.admin.select().from(users).where(eq(users.email, email));
    expect(row, "the original address must still identify the account").toBeTruthy();
    expect(row!.isPlatformAdmin).toBe(false);
    expect(row!.emailVerified).toBe(true);
    const swapped = await c.admin.select().from(users).where(eq(users.email, "swapped@example.test"));
    expect(swapped).toHaveLength(0);
  });

  it("our own profile endpoint accepts only name, locale and timezone (strict schema)", async () => {
    const { client } = await registerAndSignIn(app, "profile");
    for (const body of [{ isPlatformAdmin: true }, { emailVerified: false }, { email: "x@y.test" }, { id: "x" }, { locale: "fr" }, { timezone: "Mars/Olympus" }]) {
      const r = await client.route(mePATCH as never, "PATCH", "/api/me", body);
      expect(r.status, JSON.stringify(body)).toBe(422);
    }
    expect((await client.route(mePATCH as never, "PATCH", "/api/me", { name: "Renamed", locale: "en", timezone: "Asia/Tokyo" })).status).toBe(200);
  });
});
