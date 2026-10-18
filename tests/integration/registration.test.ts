import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { getOrgSettings, setRegistrationOpen } from "@/data/org-settings";
import { requestAccess } from "@/data/account";
import { CLOSED_SIGNUP_PER_HOUR, canRegister, refuseClosedSignUp, registrationState, soleOrganization } from "@/server/registration";
import { POST as authRoute } from "@/app/api/auth/[...all]/route";
import { auditLogs, invitations, memberships, organizations, users } from "@/db/schema";
import { GET as authConfigGET } from "@/app/api/auth-config/route";
import { GET as settingsGET, PUT as settingsPUT } from "@/app/api/orgs/[orgId]/settings/route";
import { POST as accessRequestPOST } from "@/app/api/access-requests/route";
import { addMember, connect, makeOrg, makeUser, systemRoleId } from "./helpers";
import { Client, PASSWORD, makeAuthApp, registerAndSignIn } from "./auth-helpers";

const c = connect();
const app = makeAuthApp(c.app);

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`;
  }
}

/**
 * The integration database is shared by every test file and holds many organizations. This file needs a known universe,
 * so every other organization is hidden (soft-deleted) for its duration and put back exactly as it was afterwards.
 */
let hidden: { id: string; deletedAt: Date | null; open: boolean }[] = [];

describe("registration switch and the single organization", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  const u: Record<string, { id: string }> = {};
  const as = (k: string) => ({ userId: u[k]!.id, orgId: O.org.id });
  const setFlag = (open: boolean) => c.admin.update(organizations).set({ registrationOpen: open }).where(eq(organizations.id, O.org.id));

  beforeAll(async () => {
    O = await makeOrg(c.admin, "RegOrg");
    hidden = (await c.admin.select({ id: organizations.id, deletedAt: organizations.deletedAt, open: organizations.registrationOpen }).from(organizations)).filter((o) => o.id !== O.org.id);
    await c.admin.update(organizations).set({ deletedAt: new Date() }).where(inArray(organizations.id, hidden.map((h) => h.id)));
    for (const k of ["admin", "manager", "member", "viewer", "norole", "otherAdmin"]) u[k] = await makeUser(c.admin, k);
    await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
    await addMember(c.admin, O.org.id, u.manager!.id, { role: "manager" });
    await addMember(c.admin, O.org.id, u.member!.id, { role: "member" });
    await addMember(c.admin, O.org.id, u.viewer!.id, { role: "viewer" });
    await addMember(c.admin, O.org.id, u.norole!.id, {});
  });

  afterAll(async () => {
    for (const h of hidden) await c.admin.update(organizations).set({ deletedAt: h.deletedAt, registrationOpen: h.open }).where(eq(organizations.id, h.id));
    await c.admin.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, O.org.id));
    await c.close();
  });

  describe("who may change it", () => {
    it("is on by default for a new organization", async () => {
      const [row] = await c.admin.select({ open: organizations.registrationOpen }).from(organizations).where(eq(organizations.id, O.org.id));
      expect(row!.open).toBe(true);
    });

    it.each(["manager", "member", "viewer", "norole"])("%s can neither read nor change the setting", async (k) => {
      expect(await code(withTenant(c.app, as(k), (s) => getOrgSettings(s)))).toBe("FORBIDDEN");
      expect(await code(withTenant(c.app, as(k), (s) => setRegistrationOpen(s, false)))).toBe("FORBIDDEN");
      const [row] = await c.admin.select({ open: organizations.registrationOpen }).from(organizations).where(eq(organizations.id, O.org.id));
      expect(row!.open).toBe(true);
    });

    it("an administrator of another organization cannot reach it", async () => {
      const other = await makeOrg(c.admin, "Elsewhere");
      try {
        await addMember(c.admin, other.org.id, u.otherAdmin!.id, { role: "orgadmin" });
        expect(await code(withTenant(c.app, { userId: u.otherAdmin!.id, orgId: O.org.id }, (s) => setRegistrationOpen(s, false)))).toBe("NOT_FOUND");
        // and what they do in their own organization does not touch this one
        await withTenant(c.app, { userId: u.otherAdmin!.id, orgId: other.org.id }, (s) => setRegistrationOpen(s, false));
        const [mine] = await c.admin.select({ open: organizations.registrationOpen }).from(organizations).where(eq(organizations.id, O.org.id));
        const [theirs] = await c.admin.select({ open: organizations.registrationOpen }).from(organizations).where(eq(organizations.id, other.org.id));
        expect(mine!.open).toBe(true);
        expect(theirs!.open).toBe(false);
      } finally {
        await c.admin.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, other.org.id));
      }
    });

    it("an administrator closes and reopens it, and each change is audited", async () => {
      expect(await withTenant(c.app, as("admin"), (s) => getOrgSettings(s))).toMatchObject({ registrationOpen: true });
      expect(await withTenant(c.app, as("admin"), (s) => setRegistrationOpen(s, false))).toEqual({ registrationOpen: false });
      expect(await withTenant(c.app, as("admin"), (s) => getOrgSettings(s))).toMatchObject({ registrationOpen: false });
      await withTenant(c.app, as("admin"), (s) => setRegistrationOpen(s, true));
      const actions = (await c.admin.select({ a: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.actorUserId, u.admin!.id)))).map((r) => r.a);
      expect(actions).toEqual(expect.arrayContaining(["org.registration_close", "org.registration_open"]));
    });
  });

  describe("over HTTP", () => {
    it("rejects the anonymous, the unpermitted and malformed bodies; applies a valid change", async () => {
      const anon = new Client(app.auth);
      expect((await anon.route(settingsPUT as never, "PUT", `/api/orgs/${O.org.id}/settings`, { registrationOpen: false }, { orgId: O.org.id })).status).toBe(401);
      expect((await anon.route(settingsGET as never, "GET", `/api/orgs/${O.org.id}/settings`, undefined, { orgId: O.org.id })).status).toBe(401);

      const { client: memberClient, email: memberEmail } = await registerAndSignIn(app, "regmember");
      const [mu] = await c.admin.select({ id: users.id }).from(users).where(eq(users.email, memberEmail));
      await addMember(c.admin, O.org.id, mu!.id, { role: "member" });
      expect((await memberClient.route(settingsPUT as never, "PUT", `/api/orgs/${O.org.id}/settings`, { registrationOpen: false }, { orgId: O.org.id })).status).toBe(403);

      const { client: adminClient, email: adminEmail } = await registerAndSignIn(app, "regadmin");
      const [au] = await c.admin.select({ id: users.id }).from(users).where(eq(users.email, adminEmail));
      await addMember(c.admin, O.org.id, au!.id, { role: "orgadmin" });
      const put = (body: unknown) => adminClient.route(settingsPUT as never, "PUT", `/api/orgs/${O.org.id}/settings`, body, { orgId: O.org.id });
      expect((await put({ registrationOpen: "yes" })).status).toBe(422);
      expect((await put({ registrationOpen: false, name: "hijacked" })).status).toBe(422);
      expect((await put({})).status).toBe(422);
      const ok = await put({ registrationOpen: false });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ registrationOpen: false });
      const get = await adminClient.route(settingsGET as never, "GET", `/api/orgs/${O.org.id}/settings`, undefined, { orgId: O.org.id });
      expect(await get.json()).toMatchObject({ registrationOpen: false });
      await setFlag(true);
    });
  });

  describe("who may create an account", () => {
    const invite = async (email: string, patch: Partial<typeof invitations.$inferInsert> = {}) => {
      const [row] = await c.admin.insert(invitations).values({
        orgId: O.org.id, email, roleId: await systemRoleId(c.admin, "member"), tokenHash: `h-${Math.random().toString(36).slice(2)}-${email}`,
        expiresAt: new Date(Date.now() + 3600_000), ...patch,
      }).returning({ id: invitations.id });
      return row!.id;
    };

    it("anybody while registration is open", async () => {
      await setFlag(true);
      expect(await canRegister(c.app, "anyone@example.test")).toBe(true);
      expect(await registrationState(c.app)).toEqual({ organizations: 1, open: true });
    });

    it("only an address holding a valid invitation once it is closed (case does not matter)", async () => {
      await setFlag(false);
      expect(await registrationState(c.app)).toEqual({ organizations: 1, open: false });
      expect(await canRegister(c.app, "stranger@example.test")).toBe(false);
      await invite("friend@example.test");
      expect(await canRegister(c.app, "Friend@Example.test")).toBe(true);
      expect(await canRegister(c.app, "stranger@example.test")).toBe(false);
    });

    it("an expired, revoked or already used invitation does not count", async () => {
      await setFlag(false);
      await invite("late@example.test", { expiresAt: new Date(Date.now() - 1000) });
      await invite("revoked@example.test", { revokedAt: new Date() });
      await invite("used@example.test", { acceptedAt: new Date() });
      for (const e of ["late", "revoked", "used"]) expect(await canRegister(c.app, `${e}@example.test`)).toBe(false);
    });

    it("anybody when there is no organization yet (a fresh installation), and nobody is 'sole' then", async () => {
      await c.admin.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, O.org.id));
      try {
        expect(await canRegister(c.app, "first@example.test")).toBe(true);
        expect(await registrationState(c.app)).toEqual({ organizations: 0, open: true });
        expect(await soleOrganization(c.app)).toBeNull();
      } finally {
        await c.admin.update(organizations).set({ deletedAt: null }).where(eq(organizations.id, O.org.id));
      }
    });

    it("sign-up is refused with REGISTRATION_CLOSED while closed, leaves no account behind, and works for an invited address", async () => {
      await setFlag(false);
      const signUp = (email: string) => authRoute(new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ email, password: PASSWORD, name: "Someone" }),
      }));
      const email = `stranger-${Date.now()}@example.test`;
      const refused = await signUp(email);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "REGISTRATION_CLOSED" });
      expect(await c.admin.select({ id: users.id }).from(users).where(eq(users.email, email))).toHaveLength(0);

      const invited = `invited-${Date.now()}@example.test`;
      await invite(invited);
      expect((await signUp(invited)).status).toBe(200);
      expect(await c.admin.select({ id: users.id }).from(users).where(eq(users.email, invited))).toHaveLength(1);

      await setFlag(true);
      expect((await signUp(email)).status).toBe(200);
      expect(await c.admin.select({ id: users.id }).from(users).where(eq(users.email, email))).toHaveLength(1);
    });

    it("even a request that skips the route in front of Better Auth cannot create an account while closed (the creation hook refuses too)", async () => {
      await setFlag(false);
      const email = `sneaky-${Date.now()}@example.test`;
      await new Client(app.auth).authCall("POST", "/sign-up/email", { email, password: PASSWORD, name: "Sneaky" });
      expect(await c.admin.select({ id: users.id }).from(users).where(eq(users.email, email))).toHaveLength(0);
      const invited = `sneaky-invited-${Date.now()}@example.test`;
      await invite(invited);
      await new Client(app.auth).authCall("POST", "/sign-up/email", { email: invited, password: PASSWORD, name: "Invited" });
      expect(await c.admin.select({ id: users.id }).from(users).where(eq(users.email, invited))).toHaveLength(1);
      await setFlag(true);
    });

    it("while closed, sign-up attempts share one hourly allowance, so addresses cannot be tried one by one; open registration is never limited", async () => {
      const KEY = "signup:closed";
      const reset = () => c.admin.execute(sql`delete from app_rate_limits where key = ${KEY}`);
      const attempt = async (email: string) => (await authRoute(new Request("http://localhost:3000/api/auth/sign-up/email", {
        method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify({ email, password: PASSWORD, name: "Someone" }),
      }))).status;
      await setFlag(false);
      await reset();
      try {
        const invited = `invited-${Date.now()}@example.test`;
        await invite(invited);
        const codes: number[] = [];
        for (let i = 0; i < CLOSED_SIGNUP_PER_HOUR; i++) codes.push(await attempt(`nobody-${i}-${Date.now()}@example.test`));
        expect(codes.every((x) => x === 403)).toBe(true);
        // over the allowance: the answer no longer depends on the address, invited or not
        expect(await attempt(`one-more-${Date.now()}@example.test`)).toBe(429);
        expect(await attempt(invited)).toBe(429);
        expect(await c.admin.select({ id: users.id }).from(users).where(eq(users.email, invited))).toHaveLength(0);
        // open registration does not use the allowance at all
        await setFlag(true);
        expect(await attempt(`open-${Date.now()}@example.test`)).toBe(200);
        await setFlag(false);
        await reset();
        expect(await attempt(invited)).toBe(200);
      } finally { await reset(); await setFlag(true); }
    });

    it("a sign-up body that is not JSON is not looked at by the front check (the hook still decides)", async () => {
      await setFlag(false);
      const res = await refuseClosedSignUp(new Request("http://localhost:3000/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "text/plain" }, body: "email=a@b.c" }), c.app);
      expect(res).toBeNull();
      await setFlag(true);
    });

    it("closing does not touch people who already have accounts: they still sign in", async () => {
      await setFlag(true);
      const { email } = await registerAndSignIn(app, "veteran");
      await setFlag(false);
      const again = new Client(app.auth);
      expect((await again.authCall("POST", "/sign-in/email", { email, password: PASSWORD })).status).toBe(200);
      await setFlag(true);
    });
  });

  describe("asking to join", () => {
    let person: { id: string };
    beforeAll(async () => { person = await makeUser(c.admin, "joiner"); });
    const rows = () => c.admin.select().from(memberships).where(and(eq(memberships.orgId, O.org.id), eq(memberships.userId, person.id)));

    it("without a code it goes to the only organization", async () => {
      await setFlag(true);
      expect(await requestAccess(c.app, person.id)).toEqual({ status: "submitted" });
      const m = await rows();
      expect(m).toHaveLength(1);
      expect(m[0]!.status).toBe("pending");
    });

    it("is refused with REGISTRATION_CLOSED while closed, with or without the code", async () => {
      await setFlag(false);
      const p2 = await makeUser(c.admin, "joiner2");
      const slug = (await c.admin.select({ s: organizations.slug }).from(organizations).where(eq(organizations.id, O.org.id)))[0]!.s;
      expect(await code(requestAccess(c.app, p2.id))).toBe("REGISTRATION_CLOSED");
      expect(await code(requestAccess(c.app, p2.id, slug))).toBe("REGISTRATION_CLOSED");
      expect(await c.admin.select().from(memberships).where(eq(memberships.userId, p2.id))).toHaveLength(0);
      await setFlag(true);
    });

    it("an unknown code still looks like success, and creates nothing", async () => {
      const p3 = await makeUser(c.admin, "joiner3");
      expect(await requestAccess(c.app, p3.id, "no-such-organization")).toEqual({ status: "submitted" });
      expect(await c.admin.select().from(memberships).where(eq(memberships.userId, p3.id))).toHaveLength(0);
    });

    it("without a code and with several organizations nothing is guessed", async () => {
      const second = await makeOrg(c.admin, "SecondOne");
      try {
        const p4 = await makeUser(c.admin, "joiner4");
        expect(await requestAccess(c.app, p4.id)).toEqual({ status: "submitted" });
        expect(await c.admin.select().from(memberships).where(eq(memberships.userId, p4.id))).toHaveLength(0);
        expect(await soleOrganization(c.app)).toBeNull();
      } finally {
        await c.admin.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, second.org.id));
      }
    });

    it("over HTTP the code is optional but nothing else is", async () => {
      await setFlag(true);
      const { client, email } = await registerAndSignIn(app, "httpjoin");
      const post = (body: unknown) => client.route(accessRequestPOST as never, "POST", "/api/access-requests", body);
      expect((await post({})).status).toBe(202);
      const [me] = await c.admin.select({ id: users.id }).from(users).where(eq(users.email, email));
      expect(await c.admin.select().from(memberships).where(and(eq(memberships.userId, me!.id), eq(memberships.orgId, O.org.id)))).toHaveLength(1);
      expect((await post({ orgSlug: "x".repeat(65) })).status).toBe(422);
      expect((await post({ somethingElse: true })).status).toBe(422);
    });
  });

  describe("what the sign-in pages are told", () => {
    it("reports whether registration is open and whether there is a single organization", async () => {
      await setFlag(true);
      expect(await (await authConfigGET()).json()).toMatchObject({ registrationOpen: true, singleOrganization: true });
      await setFlag(false);
      expect(await (await authConfigGET()).json()).toMatchObject({ registrationOpen: false, singleOrganization: true });
      await setFlag(true);
      const second = await makeOrg(c.admin, "Third");
      try {
        expect(await (await authConfigGET()).json()).toMatchObject({ singleOrganization: false });
      } finally {
        await c.admin.update(organizations).set({ deletedAt: new Date() }).where(eq(organizations.id, second.org.id));
      }
      // nothing about an organization other than those two flags
      const body = await (await authConfigGET()).json();
      expect(Object.keys(body).filter((k) => k !== "google").sort()).toEqual(["registrationOpen", "singleOrganization"]);
    });
  });
});
