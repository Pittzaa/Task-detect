import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import {
  acceptInvitation, approveMembership, assignRole, createCustomRole, createInvitation, deleteCustomRole, listMembers,
  removeAssignment, requestAccess, revokeInvitation, setMembershipStatus, updateCustomRolePermissions,
} from "@/data/account";
import { bootstrapOrganization } from "@/data/bootstrap";
import { auditLogs, invitations, memberships, roleAssignments, users } from "@/db/schema";
import { sha256Hex } from "@/lib/crypto";
import { POST as inviteRoute } from "@/app/api/orgs/[orgId]/invitations/route";
import { POST as approveRoute } from "@/app/api/orgs/[orgId]/members/[membershipId]/approve/route";
import { GET as membersRoute } from "@/app/api/orgs/[orgId]/members/route";
import { POST as acceptRoute } from "@/app/api/invitations/accept/route";
import { addMember, connect, liftInviteAddressLimit, makeOrg, makeUser, systemRoleId } from "./helpers";
import { linkIn, makeAuthApp, registerAndSignIn } from "./auth-helpers";

const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; }
}

describe("invitations", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let admin: { id: string };
  let memberUser: { id: string };

  beforeAll(async () => {
    O = await makeOrg(c.admin, "InviteOrg");
    admin = await makeUser(c.admin, "invadmin");
    memberUser = await makeUser(c.admin, "invmember");
    await addMember(c.admin, O.org.id, admin.id, { role: "orgadmin" });
    await addMember(c.admin, O.org.id, memberUser.id, { role: "member" });
  });

  const asAdmin = { get v() { return { userId: admin.id, orgId: O.org.id }; } };

  it("only users with org.manage_members may invite", async () => {
    const role = await systemRoleId(c.admin, "viewer");
    expect(await code(withTenant(c.app, { userId: memberUser.id, orgId: O.org.id }, (s) => createInvitation(s, { email: "x@example.test", roleId: role })))).toBe("FORBIDDEN");
  });

  it("stores only a hash of the token", async () => {
    const role = await systemRoleId(c.admin, "viewer");
    const inv = await withTenant(c.app, asAdmin.v, (s) => createInvitation(s, { email: "Hash@Example.test", roleId: role }));
    const [row] = await c.admin.select().from(invitations).where(eq(invitations.id, inv.id));
    expect(row!.tokenHash).toBe(sha256Hex(inv.token));
    expect(row!.tokenHash).not.toContain(inv.token);
    expect(row!.email).toBe("hash@example.test");
  });

  it("cannot invite someone into a role more powerful than the inviter's own", async () => {
    const mgr = await makeUser(c.admin, "invmgr");
    await addMember(c.admin, O.org.id, mgr.id, { role: "manager" });
    // manager lacks org.manage_members entirely, so give it via a custom role to test the escalation guard
    const custom = await withTenant(c.app, asAdmin.v, (s) => createCustomRole(s, { key: "inviter", name: "Inviter", permissions: ["org.manage_members", "org.read"] }));
    const m = await makeUser(c.admin, "custinviter");
    const mem = await addMember(c.admin, O.org.id, m.id, {});
    await c.admin.insert(roleAssignments).values({ orgId: O.org.id, membershipId: mem.id, roleId: custom.id, scopeType: "organization" });
    const adminRole = await systemRoleId(c.admin, "orgadmin");
    expect(await code(withTenant(c.app, { userId: m.id, orgId: O.org.id }, (s) => createInvitation(s, { email: "e@example.test", roleId: adminRole })))).toBe("FORBIDDEN");
  });

  it("full flow over HTTP: invite -> email -> register -> accept -> approved with the invited role", async () => {
    const { client: adminClient } = await registerAndSignIn(app, "flowadmin");
    const [au] = await c.admin.select().from(users).where(eq(users.name, "flowadmin"));
    await addMember(c.admin, O.org.id, au!.id, { role: "orgadmin" });
    const role = await systemRoleId(c.admin, "member");
    const inviteeEmail = `invitee-${Date.now()}@example.test`;
    const res = await adminClient.route(inviteRoute as never, "POST", `/api/orgs/${O.org.id}/invitations`, { email: inviteeEmail, roleId: role, locale: "en" }, { orgId: O.org.id });
    expect(res.status).toBe(201);
    const mail = app.email.sent.at(-1)!;
    expect(mail.to).toBe(inviteeEmail);
    expect(mail.subject).toContain("InviteOrg");
    const token = new URL(linkIn(mail.text)).searchParams.get("token")!;
    expect(mail.html.startsWith("<!doctype html>")).toBe(true); // every e-mail is HTML, with the plain text above as its twin
    expect(mail.html).toContain(`href="http://localhost:3000/invite?token=${token}"`);
    expect(mail.html).toContain("InviteOrg");

    // A different signed-in user cannot use the token
    const { client: other } = await registerAndSignIn(app, "intruder");
    expect((await other.route(acceptRoute as never, "POST", "/api/invitations/accept", { token })).status).toBe(404);

    // The invitee registers with the invited address, then accepts
    const { Client, PASSWORD } = await import("./auth-helpers");
    const inviteeClient = new Client(app.auth);
    await inviteeClient.authCall("POST", "/sign-up/email", { email: inviteeEmail, password: PASSWORD, name: "Invitee" });
    await app.auth.handler(new Request(linkIn(app.email.sent.find((m) => m.to === inviteeEmail && /verify-email/.test(m.text))!.text)));
    await inviteeClient.authCall("POST", "/sign-in/email", { email: inviteeEmail, password: PASSWORD });
    expect((await inviteeClient.route(acceptRoute as never, "POST", "/api/invitations/accept", { token })).status).toBe(200);
    const [iu] = await c.admin.select().from(users).where(eq(users.email, inviteeEmail));
    const [mem] = await c.admin.select().from(memberships).where(and(eq(memberships.userId, iu!.id), eq(memberships.orgId, O.org.id)));
    expect(mem!.status).toBe("approved");
    const assigns = await c.admin.select().from(roleAssignments).where(eq(roleAssignments.membershipId, mem!.id));
    expect(assigns.map((a) => a.roleId)).toEqual([role]);

    // single use
    expect((await inviteeClient.route(acceptRoute as never, "POST", "/api/invitations/accept", { token })).status).toBe(404);
    // and the invitee can now read org data permitted to a member
    const list = await inviteeClient.route(membersRoute as never, "GET", `/api/orgs/${O.org.id}/members`, undefined, { orgId: O.org.id });
    expect(list.status).toBe(403); // members lack org.manage_members: authenticated + approved, but not permitted
  });

  it("expired, revoked, wrong-email and unverified-email attempts all look like NOT_FOUND", async () => {
    const role = await systemRoleId(c.admin, "viewer");
    const u = await makeUser(c.admin, "acceptor");
    await c.admin.update(users).set({ emailVerified: true, email: "acceptor@example.test" }).where(eq(users.id, u.id));
    const mk = async (email: string) => { await liftInviteAddressLimit(c.admin); return withTenant(c.app, asAdmin.v, (s) => createInvitation(s, { email, roleId: role })); };

    const expired = await mk("acceptor@example.test");
    await c.admin.update(invitations).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(invitations.id, expired.id));
    expect(await code(acceptInvitation(c.app, { id: u.id, email: "acceptor@example.test", emailVerified: true }, expired.token))).toBe("NOT_FOUND");

    const revoked = await mk("acceptor@example.test");
    await withTenant(c.app, asAdmin.v, (s) => revokeInvitation(s, revoked.id));
    expect(await code(acceptInvitation(c.app, { id: u.id, email: "acceptor@example.test", emailVerified: true }, revoked.token))).toBe("NOT_FOUND");

    const wrong = await mk("someone-else@example.test");
    expect(await code(acceptInvitation(c.app, { id: u.id, email: "acceptor@example.test", emailVerified: true }, wrong.token))).toBe("NOT_FOUND");

    const unverified = await mk("acceptor@example.test");
    expect(await code(acceptInvitation(c.app, { id: u.id, email: "acceptor@example.test", emailVerified: false }, unverified.token))).toBe("NOT_FOUND");

    expect(await code(acceptInvitation(c.app, { id: u.id, email: "acceptor@example.test", emailVerified: true }, "x".repeat(43)))).toBe("NOT_FOUND");
  });

  it("two concurrent accepts of one invitation: exactly one wins", async () => {
    const role = await systemRoleId(c.admin, "viewer");
    const u = await makeUser(c.admin, "racer");
    await c.admin.update(users).set({ emailVerified: true, email: "racer@example.test" }).where(eq(users.id, u.id));
    const inv = await withTenant(c.app, asAdmin.v, (s) => createInvitation(s, { email: "racer@example.test", roleId: role }));
    const user = { id: u.id, email: "racer@example.test", emailVerified: true };
    const results = await Promise.all([acceptInvitation(c.app, user, inv.token), acceptInvitation(c.app, user, inv.token)].map(code));
    expect(results.filter((r) => r === "OK")).toHaveLength(1);
    const rows = await c.admin.select().from(memberships).where(and(eq(memberships.userId, u.id), eq(memberships.orgId, O.org.id)));
    expect(rows).toHaveLength(1);
  });

  it("bootstrap creates an org plus an orgadmin invitation that works end to end", async () => {
    const slug = `boot-${Date.now()}`;
    const r = await bootstrapOrganization(c.admin, { name: "Boot Org", slug, adminEmail: "Boss@Example.test", appUrl: "http://localhost:3000", allowAdditional: true });
    const token = new URL(r.inviteUrl).searchParams.get("token")!;
    const boss = await makeUser(c.admin, "boss");
    await c.admin.update(users).set({ emailVerified: true, email: "boss@example.test" }).where(eq(users.id, boss.id));
    await acceptInvitation(c.app, { id: boss.id, email: "boss@example.test", emailVerified: true }, token);
    const members = await withTenant(c.app, { userId: boss.id, orgId: r.orgId }, (s) => listMembers(s));
    expect(members).toHaveLength(1);
    expect(members[0]!.roles.map((x) => x.roleKey)).toEqual(["orgadmin"]);
  });

  it("e-mails are limited per address: a second invitation within a quarter of an hour is refused, another address is not, and the limit lifts", async () => {
    const role = await systemRoleId(c.admin, "viewer");
    await liftInviteAddressLimit(c.admin);
    const invite = (email: string) => withTenant(c.app, asAdmin.v, (s) => createInvitation(s, { email, roleId: role }));
    await invite("limited-one@example.test");
    expect(await code(invite("Limited-One@example.test "))).toBe("RATE_LIMITED"); // written differently, still the same address
    await invite("limited-two@example.test");
    const rows = await c.admin.select().from(invitations).where(eq(invitations.email, "limited-one@example.test"));
    expect(rows).toHaveLength(1); // the refused one left nothing behind
    await liftInviteAddressLimit(c.admin); // stands in for the quarter of an hour passing
    await invite("limited-one@example.test");
  });
});

describe("invitation e-mail that could not be sent", () => {
  it("does not use up the address's allowance: the invitation can be sent again at once, and only a delivered one starts the wait", async () => {
    const O = await makeOrg(c.admin, "InviteRefundOrg");
    const { client } = await registerAndSignIn(app, "refundadmin");
    const [au] = await c.admin.select().from(users).where(eq(users.name, "refundadmin"));
    await addMember(c.admin, O.org.id, au!.id, { role: "orgadmin" });
    const role = await systemRoleId(c.admin, "viewer");
    const email = `refund-${Date.now()}@example.test`;
    const post = () => client.route(inviteRoute as never, "POST", `/api/orgs/${O.org.id}/invitations`, { email, roleId: role, locale: "en" }, { orgId: O.org.id });

    const send = app.email.send;
    app.email.send = async () => { throw new Error("provider down"); };
    let first: Response;
    try { first = await post(); } finally { app.email.send = send; }
    expect(first.status).toBe(201);
    expect((await first.json()) as { emailed: boolean }).toMatchObject({ emailed: false });

    const second = await post(); // nothing reached the address, so it is not "within a quarter of an hour"
    expect(second.status).toBe(201);
    expect((await second.json()) as { emailed: boolean }).toMatchObject({ emailed: true });

    expect((await post()).status).toBe(429); // delivered once: now the wait applies
  });
});

describe("join requests and approval", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let slug: string;
  let admin: { id: string };
  const as = (userId: string) => ({ userId, orgId: O.org.id });

  beforeAll(async () => {
    O = await makeOrg(c.admin, "ApprovalOrg");
    slug = O.org.slug;
    admin = await makeUser(c.admin, "apradmin");
    await addMember(c.admin, O.org.id, admin.id, { role: "orgadmin" });
  });

  it("requestAccess is idempotent and rate limited", async () => {
    const u = await makeUser(c.admin, "req");
    await requestAccess(c.app, u.id, slug);
    await requestAccess(c.app, u.id, slug);
    const rows = await c.admin.select().from(memberships).where(eq(memberships.userId, u.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    const spam = await makeUser(c.admin, "spam");
    const out: string[] = [];
    for (let i = 0; i < 7; i++) out.push(await code(requestAccess(c.app, spam.id, "nonexistent-org")));
    expect(out.slice(0, 5)).toEqual(Array(5).fill("OK"));
    expect(out.slice(5)).toEqual(["RATE_LIMITED", "RATE_LIMITED"]);
  });

  it("a revoked user cannot reset their status by requesting again", async () => {
    const u = await makeUser(c.admin, "revokedreq");
    await addMember(c.admin, O.org.id, u.id, { status: "revoked" });
    await requestAccess(c.app, u.id, slug);
    const [m] = await c.admin.select().from(memberships).where(eq(memberships.userId, u.id));
    expect(m!.status).toBe("revoked");
  });

  it("admin approves a pending member with a role; the member gains exactly that access", async () => {
    const u = await makeUser(c.admin, "pend");
    await requestAccess(c.app, u.id, slug);
    const pending = await withTenant(c.app, as(admin.id), (s) => listMembers(s, { status: "pending" }));
    const target = pending.find((m) => m.userId === u.id)!;
    expect(await code(withTenant(c.app, as(u.id), (s) => listMembers(s)))).toBe("NOT_FOUND"); // still pending
    await withTenant(c.app, as(admin.id), (s) => approveMembership(s, { membershipId: target.id, roleId: await_(systemRoleIds, "viewer") }));
    expect(await code(withTenant(c.app, as(u.id), (s) => listMembers(s)))).toBe("FORBIDDEN"); // approved viewer, no manage_members
    expect(await code(withTenant(c.app, as(admin.id), (s) => approveMembership(s, { membershipId: target.id, roleId: await_(systemRoleIds, "viewer") })))).toBe("CONFLICT");
  });

  it("approval is audited and non-admins cannot approve", async () => {
    const u = await makeUser(c.admin, "pend2");
    await requestAccess(c.app, u.id, slug);
    const [m] = await c.admin.select().from(memberships).where(eq(memberships.userId, u.id));
    const mgr = await makeUser(c.admin, "aprmgr");
    await addMember(c.admin, O.org.id, mgr.id, { role: "manager" });
    expect(await code(withTenant(c.app, as(mgr.id), (s) => approveMembership(s, { membershipId: m!.id, roleId: await_(systemRoleIds, "viewer") })))).toBe("FORBIDDEN");
    await withTenant(c.app, as(admin.id), (s) => approveMembership(s, { membershipId: m!.id, roleId: await_(systemRoleIds, "viewer") }));
    const logs = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.targetId, m!.id), eq(auditLogs.action, "membership.approve")));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.actorUserId).toBe(admin.id);
  });

  it("approval over HTTP", async () => {
    const { client: adminClient } = await registerAndSignIn(app, "httpadmin");
    const [au] = await c.admin.select().from(users).where(eq(users.name, "httpadmin"));
    await addMember(c.admin, O.org.id, au!.id, { role: "orgadmin" });
    const u = await makeUser(c.admin, "httppend");
    await requestAccess(c.app, u.id, slug);
    const [m] = await c.admin.select().from(memberships).where(eq(memberships.userId, u.id));
    const res = await adminClient.route(approveRoute as never, "POST", `/api/orgs/${O.org.id}/members/${m!.id}/approve`, { roleId: await_(systemRoleIds, "member") }, { orgId: O.org.id, membershipId: m!.id });
    expect(res.status).toBe(200);
    expect((await adminClient.route(approveRoute as never, "POST", `/api/orgs/${O.org.id}/members/${m!.id}/approve`, { roleId: "not-a-uuid" }, { orgId: O.org.id, membershipId: m!.id })).status).toBe(422);
  });

  it("suspension takes effect on the very next request", async () => {
    const u = await makeUser(c.admin, "susp");
    const m = await addMember(c.admin, O.org.id, u.id, { role: "viewer" });
    expect(await code(withTenant(c.app, as(u.id), async (s) => s.require("project.read")))).toBe("OK");
    await withTenant(c.app, as(admin.id), (s) => setMembershipStatus(s, { membershipId: m.id, status: "suspended" }));
    expect(await code(withTenant(c.app, as(u.id), async (s) => s.require("project.read")))).toBe("NOT_FOUND");
    await withTenant(c.app, as(admin.id), (s) => setMembershipStatus(s, { membershipId: m.id, status: "approved" }));
    expect(await code(withTenant(c.app, as(u.id), async (s) => s.require("project.read")))).toBe("OK");
  });
});

// system role ids resolved lazily in beforeAll of a tiny describe to keep fixtures local
const systemRoleIds = new Map<string, string>();
function await_(m: Map<string, string>, key: string) {
  const v = m.get(key);
  if (!v) throw new Error("system role ids not loaded");
  return v;
}
beforeAll(async () => {
  for (const k of ["orgadmin", "manager", "member", "viewer"]) systemRoleIds.set(k, await systemRoleId(c.admin, k));
});

describe("administrator safety and privilege escalation", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let a1: { id: string }; let a2: { id: string };
  let m1: { id: string }; let m2: { id: string };
  const as = (userId: string) => ({ userId, orgId: O.org.id });

  beforeAll(async () => {
    O = await makeOrg(c.admin, "SafetyOrg");
    a1 = await makeUser(c.admin, "sa1"); a2 = await makeUser(c.admin, "sa2");
    m1 = await addMember(c.admin, O.org.id, a1.id, { role: "orgadmin" });
    m2 = await addMember(c.admin, O.org.id, a2.id, { role: "orgadmin" });
  });

  it("cannot suspend or revoke yourself", async () => {
    expect(await code(withTenant(c.app, as(a1.id), (s) => setMembershipStatus(s, { membershipId: m1.id, status: "suspended" })))).toBe("CONFLICT");
  });

  it("the last administrator cannot be removed even by two admins acting simultaneously", async () => {
    const results = await Promise.all([
      code(withTenant(c.app, as(a1.id), (s) => setMembershipStatus(s, { membershipId: m2.id, status: "revoked" }))),
      code(withTenant(c.app, as(a2.id), (s) => setMembershipStatus(s, { membershipId: m1.id, status: "revoked" }))),
    ]);
    const ok = results.filter((r) => r === "OK").length;
    expect(ok).toBe(1);
    const left = await c.admin.select().from(memberships).where(and(eq(memberships.orgId, O.org.id), eq(memberships.status, "approved")));
    expect(left.length).toBe(1);
  });

  it("the last orgadmin assignment cannot be removed", async () => {
    const O2 = await makeOrg(c.admin, "SoloOrg");
    const solo = await makeUser(c.admin, "solo");
    const m = await addMember(c.admin, O2.org.id, solo.id, { role: "orgadmin" });
    const [asg] = await c.admin.select().from(roleAssignments).where(eq(roleAssignments.membershipId, m.id));
    expect(await code(withTenant(c.app, { userId: solo.id, orgId: O2.org.id }, (s) => removeAssignment(s, asg!.id)))).toBe("CONFLICT");
  });

  it("a custom role cannot be created with permissions the creator does not hold", async () => {
    const O3 = await makeOrg(c.admin, "EscOrg");
    const u = await makeUser(c.admin, "esc");
    const cust = await makeUser(c.admin, "custadmin");
    await addMember(c.admin, O3.org.id, cust.id, { role: "orgadmin" });
    // a custom 'role admin' who may manage roles but lacks org.manage_integrations
    const roleAdmin = await withTenant(c.app, { userId: cust.id, orgId: O3.org.id }, (s) => createCustomRole(s, { key: "role_admin", name: "Role admin", permissions: ["org.manage_roles", "org.read"] }));
    const mem = await addMember(c.admin, O3.org.id, u.id, {});
    await c.admin.insert(roleAssignments).values({ orgId: O3.org.id, membershipId: mem.id, roleId: roleAdmin.id, scopeType: "organization" });
    const ctx = { userId: u.id, orgId: O3.org.id };
    expect(await code(withTenant(c.app, ctx, (s) => createCustomRole(s, { key: "evil", name: "Evil", permissions: ["org.manage_integrations"] })))).toBe("FORBIDDEN");
    expect(await code(withTenant(c.app, ctx, (s) => createCustomRole(s, { key: "fine", name: "Fine", permissions: ["org.read"] })))).toBe("OK");
    // and cannot grant themselves orgadmin
    expect(await code(withTenant(c.app, ctx, (s) => assignRole(s, { membershipId: mem.id, roleId: await_(systemRoleIds, "orgadmin"), scope: { type: "organization" } })))).toBe("FORBIDDEN");
    // nor widen an existing custom role afterwards
    const fine = await c.admin.query.roles.findFirst({ where: (r, { eq: e, and: a }) => a(e(r.orgId, O3.org.id), e(r.key, "fine")) });
    expect(await code(withTenant(c.app, ctx, (s) => updateCustomRolePermissions(s, fine!.id, ["org.manage_integrations"])))).toBe("FORBIDDEN");
  });

  it("rejects reserved and invalid role keys and unknown permissions", async () => {
    const O7 = await makeOrg(c.admin, "KeyOrg");
    const k = await makeUser(c.admin, "keyadmin");
    await addMember(c.admin, O7.org.id, k.id, { role: "orgadmin" });
    const ctx = { userId: k.id, orgId: O7.org.id };
    for (const key of ["orgadmin", "superadmin", "Bad Key", "x"]) {
      expect(await code(withTenant(c.app, ctx, (s) => createCustomRole(s, { key, name: "n", permissions: [] })))).toBe("VALIDATION");
    }
    expect(await code(withTenant(c.app, ctx, (s) => createCustomRole(s, { key: "okkey", name: "n", permissions: ["task.fly"] })))).toBe("VALIDATION");
  });

  it("scoped assignment: a team manager role applies only to that team and the scope must be in the org", async () => {
    const O4 = await makeOrg(c.admin, "ScopeOrg");
    const O5 = await makeOrg(c.admin, "ForeignOrg");
    const boss = await makeUser(c.admin, "scopeboss");
    await addMember(c.admin, O4.org.id, boss.id, { role: "orgadmin" });
    const u = await makeUser(c.admin, "scoped");
    const mem = await addMember(c.admin, O4.org.id, u.id, {});
    const ctx = { userId: boss.id, orgId: O4.org.id };
    const mgr = await systemRoleId(c.admin, "manager");
    expect(await code(withTenant(c.app, ctx, (s) => assignRole(s, { membershipId: mem.id, roleId: mgr, scope: { type: "team", id: O5.team.id } })))).toBe("NOT_FOUND");
    expect(await code(withTenant(c.app, ctx, (s) => assignRole(s, { membershipId: mem.id, roleId: mgr, scope: { type: "team", id: O4.team.id } })))).toBe("OK");
    const ok = await withTenant(c.app, { userId: u.id, orgId: O4.org.id }, async (s) => { s.require("task.update", { teamId: O4.team.id }); return true; });
    expect(ok).toBe(true);
    expect(await code(withTenant(c.app, { userId: u.id, orgId: O4.org.id }, async (s) => s.require("task.update", { teamId: "00000000-0000-0000-0000-000000000000" })))).toBe("FORBIDDEN");
  });

  it("roles still assigned cannot be deleted; unassigned custom roles can", async () => {
    const O6 = await makeOrg(c.admin, "DelRoleOrg");
    const boss = await makeUser(c.admin, "delboss");
    await addMember(c.admin, O6.org.id, boss.id, { role: "orgadmin" });
    const ctx = { userId: boss.id, orgId: O6.org.id };
    const role = await withTenant(c.app, ctx, (s) => createCustomRole(s, { key: "temp", name: "Temp", permissions: ["org.read"] }));
    const u = await makeUser(c.admin, "deluser");
    const mem = await addMember(c.admin, O6.org.id, u.id, {});
    await withTenant(c.app, ctx, (s) => assignRole(s, { membershipId: mem.id, roleId: role.id, scope: { type: "organization" } }));
    expect(await code(withTenant(c.app, ctx, (s) => deleteCustomRole(s, role.id)))).toBe("CONFLICT");
    const [asg] = await c.admin.select().from(roleAssignments).where(eq(roleAssignments.roleId, role.id));
    await withTenant(c.app, ctx, (s) => removeAssignment(s, asg!.id));
    expect(await code(withTenant(c.app, ctx, (s) => deleteCustomRole(s, role.id)))).toBe("OK");
  });
});
