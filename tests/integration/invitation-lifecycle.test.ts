import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { acceptInvitation, createInvitation, setMembershipStatus } from "@/data/account";
import { eraseAccount } from "@/data/privacy";
import { invitations, memberships, users } from "@/db/schema";
import { addMember, connect, liftInviteAddressLimit, makeOrg, makeUser, systemRoleId } from "./helpers";

const c = connect();
afterAll(() => c.close());

async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; }
}

let O: Awaited<ReturnType<typeof makeOrg>>;
let boss: { id: string };
let role: string;
const asBoss = () => ({ userId: boss.id, orgId: O.org.id });

beforeAll(async () => {
  O = await makeOrg(c.admin, "InvLife");
  boss = await makeUser(c.admin, "boss");
  await addMember(c.admin, O.org.id, boss.id, { role: "orgadmin" });
  role = await systemRoleId(c.admin, "member");
});

/** A verified user with a fixed e-mail address. */
async function person(label: string) {
  const u = await makeUser(c.admin, label);
  const email = `${label}-${u.id.slice(0, 8)}@example.test`;
  await c.admin.update(users).set({ email, emailVerified: true }).where(eq(users.id, u.id));
  return { id: u.id, email, emailVerified: true };
}
const membershipOf = async (userId: string) => (await c.admin.select().from(memberships).where(and(eq(memberships.orgId, O.org.id), eq(memberships.userId, userId))))[0];
const statusOf = async (userId: string) => (await membershipOf(userId))?.status;

describe("an invitation does not outlive the standing of the people it concerns", () => {
  it("suspending a member voids an invitation addressed to them that was still unused (they cannot reinstate themselves)", async () => {
    const bob = await person("bob");
    const m = await addMember(c.admin, O.org.id, bob.id, { role: "member" }); // joined another way
    const stale = await withTenant(c.app, asBoss(), (s) => createInvitation(s, { email: bob.email, roleId: role }));
    await withTenant(c.app, asBoss(), (s) => setMembershipStatus(s, { membershipId: m.id, status: "suspended" }));
    expect(await code(acceptInvitation(c.app, bob, stale.token))).toBe("NOT_FOUND");
    expect(await statusOf(bob.id)).toBe("suspended");
  });

  it("the same for a revoked member, and for a second pending invitation after the first was used", async () => {
    const eve = await person("eve");
    const m = await addMember(c.admin, O.org.id, eve.id, { role: "member" });
    const first = await withTenant(c.app, asBoss(), (s) => createInvitation(s, { email: eve.email, roleId: role }));
    await liftInviteAddressLimit(c.admin); // a second invitation to one address within a quarter of an hour is refused (account.test.ts); this one is a fixture
    const second = await withTenant(c.app, asBoss(), (s) => createInvitation(s, { email: eve.email, roleId: role }));
    await acceptInvitation(c.app, eve, first.token);
    await withTenant(c.app, asBoss(), (s) => setMembershipStatus(s, { membershipId: m.id, status: "revoked" }));
    expect(await code(acceptInvitation(c.app, eve, second.token))).toBe("NOT_FOUND");
    expect(await statusOf(eve.id)).toBe("revoked");
  });

  it("a deliberate new invitation, sent after the suspension, still brings the person back", async () => {
    const ann = await person("ann");
    const m = await addMember(c.admin, O.org.id, ann.id, { role: "member" });
    await withTenant(c.app, asBoss(), (s) => setMembershipStatus(s, { membershipId: m.id, status: "suspended" }));
    const again = await withTenant(c.app, asBoss(), (s) => createInvitation(s, { email: ann.email, roleId: role }));
    expect(await code(acceptInvitation(c.app, ann, again.token))).toBe("OK");
    expect(await statusOf(ann.id)).toBe("approved");
  });

  it("suspending or revoking an inviter voids what they sent, so a compromised administrator cannot leave a way back in", async () => {
    const rogue = await person("rogue");
    const rogueM = await addMember(c.admin, O.org.id, rogue.id, { role: "orgadmin" });
    const outsider = await person("outsider");
    const planted = await withTenant(c.app, { userId: rogue.id, orgId: O.org.id }, (s) => createInvitation(s, { email: outsider.email, roleId: role }));
    await withTenant(c.app, asBoss(), (s) => setMembershipStatus(s, { membershipId: rogueM.id, status: "suspended" }));
    expect(await code(acceptInvitation(c.app, outsider, planted.token))).toBe("NOT_FOUND");
    expect(await membershipOf(outsider.id)).toBeUndefined();
  });

  it("invitations from other people, and to other people, are left alone", async () => {
    const keep = await person("keep");
    const other = await person("other");
    const fine = await withTenant(c.app, asBoss(), (s) => createInvitation(s, { email: keep.email, roleId: role }));
    const victim = await person("victim");
    const vm = await addMember(c.admin, O.org.id, victim.id, { role: "member" });
    await withTenant(c.app, asBoss(), (s) => setMembershipStatus(s, { membershipId: vm.id, status: "suspended" }));
    expect(await code(acceptInvitation(c.app, keep, fine.token))).toBe("OK");
    void other;
  });

  it("erasing an account voids what it sent, and what was sent to it", async () => {
    const leaver = await person("leaver");
    await addMember(c.admin, O.org.id, leaver.id, { role: "orgadmin" });
    const newcomer = await person("newcomer");
    const sent = await withTenant(c.app, { userId: leaver.id, orgId: O.org.id }, (s) => createInvitation(s, { email: newcomer.email, roleId: role }));
    const toLeaver = await withTenant(c.app, asBoss(), (s) => createInvitation(s, { email: leaver.email, roleId: role }));
    await eraseAccount(c.app, { id: leaver.id, email: leaver.email }, {});
    expect(await code(acceptInvitation(c.app, newcomer, sent.token))).toBe("NOT_FOUND");
    const rows = await c.admin.select({ revokedAt: invitations.revokedAt }).from(invitations).where(eq(invitations.id, toLeaver.id));
    expect(rows[0]!.revokedAt).not.toBeNull();
  });
});
