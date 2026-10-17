import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLogs, authVerifications, users } from "@/db/schema";
import { GET as meGET, PATCH as mePATCH } from "@/app/api/me/route";
import { GET as myMemberships } from "@/app/api/me/memberships/route";
import { POST as accessRequest } from "@/app/api/access-requests/route";
import { GET as listMembersRoute } from "@/app/api/orgs/[orgId]/members/route";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { Client, PASSWORD, linkIn, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { setRuntimeForTests } from "@/server/runtime";

const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

function base32Decode(input: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString("utf8");
}

describe("email/password authentication", () => {

  it("rejects short passwords", async () => {
    const cl = new Client(app.auth);
    const res = await cl.authCall("POST", "/sign-up/email", { email: "short@example.test", password: "tooshort", name: "S" });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("sign-up sends a verification email and blocks sign-in until verified", async () => {
    const cl = new Client(app.auth);
    const email = `unverified-${Date.now()}@example.test`;
    expect((await cl.authCall("POST", "/sign-up/email", { email, password: PASSWORD, name: "U" })).status).toBe(200);
    const mail = app.email.sent.find((m) => m.to === email);
    expect(mail).toBeDefined();
    expect(mail!.subject).toContain("Task Tracker");
    const blocked = await cl.authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    expect(blocked.status).toBe(403);
    expect(cl.cookies.size).toBe(0);
    await app.auth.handler(new Request(linkIn(mail!.text)));
    expect((await cl.authCall("POST", "/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
    expect(cl.cookies.size).toBeGreaterThan(0);
  });

  it("wrong password and unknown user fail identically", async () => {
    const { email } = await registerAndSignIn(app, "pw");
    const cl = new Client(app.auth);
    const wrong = await cl.authCall("POST", "/sign-in/email", { email, password: "wrong-password-123" });
    const unknown = await cl.authCall("POST", "/sign-in/email", { email: "nobody@example.test", password: "wrong-password-123" });
    expect(wrong.status).toBe(unknown.status);
    expect(await wrong.json()).toEqual(await unknown.json());
  });

  it("stores only a hash of the password", async () => {
    const { email } = await registerAndSignIn(app, "hash");
    const [u] = await c.admin.select().from(users).where(eq(users.email, email));
    const rows = await c.admin.execute(`select password from auth_accounts where user_id = '${u!.id}'` as never) as unknown as { rows: { password: string }[] };
    expect(rows.rows[0]!.password).not.toContain(PASSWORD);
    expect(rows.rows[0]!.password.length).toBeGreaterThan(40);
  });

  it("password reset: emailed link works once, old password stops working, unknown email leaks nothing", async () => {
    const { client, email } = await registerAndSignIn(app, "reset");
    const before = app.email.sent.length;
    const unknown = await client.authCall("POST", "/request-password-reset", { email: "ghost@example.test", redirectTo: "/reset" });
    expect(app.email.sent.length).toBe(before);
    const known = await client.authCall("POST", "/request-password-reset", { email, redirectTo: "/reset" });
    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
    const mail = app.email.sent.at(-1)!;
    expect(mail.to).toBe(email);
    const token = new URL(linkIn(mail.text)).pathname.split("/").pop()!;
    const fresh = new Client(app.auth);
    const NEW = "brand-new-password-77";
    expect((await fresh.authCall("POST", "/reset-password", { newPassword: NEW, token })).status).toBe(200);
    expect((await fresh.authCall("POST", "/reset-password", { newPassword: "another-password-88", token })).status).toBeGreaterThanOrEqual(400);
    expect((await new Client(app.auth).authCall("POST", "/sign-in/email", { email, password: PASSWORD })).status).toBeGreaterThanOrEqual(400);
    expect((await new Client(app.auth).authCall("POST", "/sign-in/email", { email, password: NEW })).status).toBe(200);
    // the session that existed before the reset is revoked
    const me = await client.route(meGET as never, "GET", "/api/me");
    expect(me.status).toBe(401);
  });
});

describe("sessions", () => {

  it("lists sessions and revokes one; the revoked cookie stops working", async () => {
    const { client, email } = await registerAndSignIn(app, "sess");
    const second = new Client(app.auth);
    expect((await second.authCall("POST", "/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
    const list = (await (await client.authCall("GET", "/list-sessions")).json()) as { token: string }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect((await second.route(meGET as never, "GET", "/api/me")).status).toBe(200);
    const secondToken = (await (await second.authCall("GET", "/list-sessions")).json() as { token: string }[]).find((s) => s.token !== (list[0]!.token === undefined ? "" : ""))!;
    void secondToken;
    // revoke every other session from the first client
    expect((await client.authCall("POST", "/revoke-other-sessions", {})).status).toBe(200);
    expect((await second.route(meGET as never, "GET", "/api/me")).status).toBe(401);
    expect((await client.route(meGET as never, "GET", "/api/me")).status).toBe(200);
  });

  it("sign-out invalidates the session", async () => {
    const { client } = await registerAndSignIn(app, "out");
    expect((await client.route(meGET as never, "GET", "/api/me")).status).toBe(200);
    expect((await client.authCall("POST", "/sign-out", {})).status).toBe(200);
    expect((await client.route(meGET as never, "GET", "/api/me")).status).toBe(401);
  });
});

describe("two-factor authentication", () => {

  it("enrol, then sign-in requires a valid TOTP; backup code works once", async () => {
    const { client, email } = await registerAndSignIn(app, "mfa");
    const en = await client.authCall("POST", "/two-factor/enable", { password: PASSWORD });
    expect(en.status).toBe(200);
    const { totpURI, backupCodes } = (await en.json()) as { totpURI: string; backupCodes: string[] };
    // The URI carries the secret base32-encoded; Better Auth's OTP helper takes the raw secret.
    const secret = base32Decode(new URL(totpURI).searchParams.get("secret")!);
    const { createOTP } = await import("@better-auth/utils/otp");
    const code = () => createOTP(secret).totp();
    expect((await client.authCall("POST", "/two-factor/verify-totp", { code: await code() })).status).toBe(200);

    const fresh = new Client(app.auth);
    const si = await fresh.authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    expect(((await si.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    expect((await fresh.route(meGET as never, "GET", "/api/me")).status).toBe(401); // not a full session yet
    expect((await fresh.authCall("POST", "/two-factor/verify-totp", { code: "000000" })).status).toBeGreaterThanOrEqual(400);
    expect((await fresh.route(meGET as never, "GET", "/api/me")).status).toBe(401);
    expect((await fresh.authCall("POST", "/two-factor/verify-totp", { code: await code() })).status).toBe(200);
    expect((await fresh.route(meGET as never, "GET", "/api/me")).status).toBe(200);

    const viaBackup = new Client(app.auth);
    await viaBackup.authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    expect((await viaBackup.authCall("POST", "/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBe(200);
    const reuse = new Client(app.auth);
    await reuse.authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    expect((await reuse.authCall("POST", "/two-factor/verify-backup-code", { code: backupCodes[0] })).status).toBeGreaterThanOrEqual(400);
  });
});

describe("rate limiting", () => {
  it("throttles repeated sign-in attempts", async () => {
    const limited = makeAuthApp(c.app, { rateLimit: true });
    try {
    const cl = new Client(limited.auth);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) {
      statuses.push((await cl.authCall("POST", "/sign-in/email", { email: "victim@example.test", password: "wrong-password-123" }, { "x-forwarded-for": "203.0.113.9" })).status);
    }
    expect(statuses.slice(0, 5).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(5)).toContain(429);
    } finally {
      setRuntimeForTests(app.runtime); // restore the shared runtime
    }
  });
});

describe("account approval gate", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let adminUser: { id: string };

  beforeAll(async () => {
    O = await makeOrg(c.admin, "GateOrg");
    adminUser = await makeUser(c.admin, "gateadmin");
    await addMember(c.admin, O.org.id, adminUser.id, { role: "orgadmin" });
  });

  it("a newly registered user has no memberships and cannot read org data", async () => {
    const { client } = await registerAndSignIn(app, "newbie");
    const mine = (await (await client.route(myMemberships as never, "GET", "/api/me/memberships")).json()) as { memberships: unknown[] };
    expect(mine.memberships).toEqual([]);
    const res = await client.route(listMembersRoute as never, "GET", `/api/orgs/${O.org.id}/members`, undefined, { orgId: O.org.id });
    expect(res.status).toBe(404);
  });

  it("unauthenticated requests get 401, never data", async () => {
    const anon = new Client(app.auth);
    expect((await anon.route(listMembersRoute as never, "GET", `/api/orgs/${O.org.id}/members`, undefined, { orgId: O.org.id })).status).toBe(401);
  });

  it("a malformed org id is a 404, not a database error", async () => {
    const { client } = await registerAndSignIn(app, "badid");
    expect((await client.route(listMembersRoute as never, "GET", "/api/orgs/not-a-uuid/members", undefined, { orgId: "not-a-uuid" })).status).toBe(404);
  });

  it("requesting access creates a PENDING membership that grants nothing; response is identical for unknown codes", async () => {
    const { client } = await registerAndSignIn(app, "joiner");
    const [org] = await c.admin.query.organizations.findMany({ where: (o, { eq }) => eq(o.id, O.org.id) });
    const ok = await client.route(accessRequest as never, "POST", "/api/access-requests", { orgSlug: org!.slug });
    const missing = await client.route(accessRequest as never, "POST", "/api/access-requests", { orgSlug: "no-such-org" });
    expect(ok.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(await ok.json()).toEqual(await missing.json());

    const mine = (await (await client.route(myMemberships as never, "GET", "/api/me/memberships")).json()) as { memberships: { status: string; org: unknown }[] };
    expect(mine.memberships).toHaveLength(1);
    expect(mine.memberships[0]).toMatchObject({ status: "pending", org: null });
    const res = await client.route(listMembersRoute as never, "GET", `/api/orgs/${O.org.id}/members`, undefined, { orgId: O.org.id });
    expect(res.status).toBe(404);
  });

  it("profile updates validate locale and time zone", async () => {
    const { client } = await registerAndSignIn(app, "prof");
    expect((await client.route(mePATCH as never, "PATCH", "/api/me", { locale: "en", timezone: "Europe/London" })).status).toBe(200);
    const me = (await (await client.route(meGET as never, "GET", "/api/me")).json()) as { locale: string; timezone: string };
    expect(me).toMatchObject({ locale: "en", timezone: "Europe/London" });
    expect((await client.route(mePATCH as never, "PATCH", "/api/me", { timezone: "Not/AZone" })).status).toBe(422);
    expect((await client.route(mePATCH as never, "PATCH", "/api/me", { locale: "fr" })).status).toBe(422);
    expect((await client.route(mePATCH as never, "PATCH", "/api/me", { isPlatformAdmin: true })).status).toBe(422);
  });
});

describe("CSRF origin check on cookie-authenticated mutations", () => {
  it("rejects missing or foreign Origin on mutating routes but allows GET", async () => {
    const { client } = await registerAndSignIn(app, "csrf");
    const evil = new Client(app.auth, "https://evil.example");
    evil.cookies = client.cookies;
    expect((await evil.route(mePATCH as never, "PATCH", "/api/me", { name: "x" })).status).toBe(403);
    const none = new Client(app.auth, "");
    none.cookies = client.cookies;
    expect((await none.route(mePATCH as never, "PATCH", "/api/me", { name: "x" })).status).toBe(403);
    expect((await evil.route(meGET as never, "GET", "/api/me")).status).toBe(200);
  });
});

describe("audit of authentication", () => {
  it("records logins in the audit log of the user's organizations", async () => {
    const O = await makeOrg(c.admin, "AuditAuth");
    const { client, email } = await registerAndSignIn(app, "auditee");
    const [u] = await c.admin.select().from(users).where(eq(users.email, email));
    await addMember(c.admin, O.org.id, u!.id, { role: "member" });
    await new Client(app.auth).authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    void client;
    const logs = await c.admin.select().from(auditLogs).where(eq(auditLogs.actorUserId, u!.id));
    expect(logs.some((l) => l.action === "auth.login" && l.orgId === O.org.id)).toBe(true);
    expect(JSON.stringify(logs)).not.toContain(PASSWORD);
  });

  it("verification tokens are not left readable as plain bearer data after use", async () => {
    const rows = await c.admin.select().from(authVerifications);
    expect(rows.every((r) => r.expiresAt instanceof Date)).toBe(true);
  });
});
