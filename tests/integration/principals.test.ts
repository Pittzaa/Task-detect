import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listPeople } from "@/data/context";
import { loadPrincipal, loadPrincipals, withTenant, type TenantSession } from "@/data/tenant";
import { can } from "@/authz/evaluate";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

let O: Awaited<ReturnType<typeof makeOrg>>;
let X: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const crowd: { id: string }[] = [];

beforeAll(async () => {
  O = await makeOrg(c.admin, "PrincipalsOrg");
  X = await makeOrg(c.admin, "PrincipalsOther");
  for (const k of ["admin", "member", "viewer", "teamMember", "projectOnly", "suspended", "norole", "outsider"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.member!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.viewer!.id, { role: "viewer" });
  await addMember(c.admin, O.org.id, u.teamMember!.id, { role: "member", scope: { type: "team", id: O.team.id } });
  await addMember(c.admin, O.org.id, u.projectOnly!.id, { role: "viewer", scope: { type: "project", id: O.project.id } });
  await addMember(c.admin, O.org.id, u.suspended!.id, { role: "member", status: "suspended" });
  await addMember(c.admin, O.org.id, u.norole!.id, {});
  await addMember(c.admin, X.org.id, u.outsider!.id, { role: "orgadmin" });
  for (let i = 0; i < 40; i++) { const p = await makeUser(c.admin, `crowd${i}`); crowd.push(p); await addMember(c.admin, O.org.id, p.id, { role: "member" }); }
});

const tx = <T>(fn: (s: TenantSession) => Promise<T>) => withTenant(c.app, { userId: u.admin!.id, orgId: O.org.id }, fn);

describe("loadPrincipals", () => {
  it("returns each member's status, scoped assignments and permissions, and nothing for non-members", async () => {
    const all = await tx((s) => loadPrincipals(s.tx, [...Object.values(u).map((x) => x.id), "00000000-0000-4000-8000-000000000000"], O.org.id));
    expect(all.has(u.outsider!.id)).toBe(false); // member of another organization only
    expect(all.has("00000000-0000-4000-8000-000000000000")).toBe(false);
    expect(all.get(u.suspended!.id)!.membershipStatus).toBe("suspended");
    expect(all.get(u.norole!.id)!.assignments).toEqual([]);
    expect(all.get(u.admin!.id)!.assignments).toHaveLength(1);
    expect(all.get(u.admin!.id)!.assignments[0]).toMatchObject({ scopeType: "organization" });
    expect(all.get(u.teamMember!.id)!.assignments[0]).toMatchObject({ scopeType: "team", teamId: O.team.id });
    expect(all.get(u.projectOnly!.id)!.assignments[0]).toMatchObject({ scopeType: "project", projectId: O.project.id });
    expect(can(all.get(u.admin!.id)!, "org.manage_members", { orgId: O.org.id })).toBe(true);
    expect(can(all.get(u.viewer!.id)!, "org.manage_members", { orgId: O.org.id })).toBe(false);
    expect(can(all.get(u.viewer!.id)!, "task.read", { orgId: O.org.id, projectId: O.project.id })).toBe(true);
    // the single-user loader gives the same answer for everybody
    for (const [id, p] of all) {
      const one = await tx((s) => loadPrincipal(s.tx, id, O.org.id));
      expect(one).toEqual(p);
    }
  });

  it("never mixes organizations", async () => {
    const mine = await tx((s) => loadPrincipals(s.tx, [u.outsider!.id], O.org.id));
    expect(mine.size).toBe(0);
    const theirs = await withTenant(c.app, { userId: u.outsider!.id, orgId: X.org.id }, (s) => loadPrincipals(s.tx, [u.outsider!.id, u.admin!.id], X.org.id));
    expect([...theirs.keys()]).toEqual([u.outsider!.id]);
  });
});

describe("listPeople", () => {
  it("returns the people who can read the project, and does not run queries per member", async () => {
    let queries = 0;
    const people = await tx((s) => {
      const counting = new Proxy(s.tx, { get: (t, p, r) => { if (p === "select" || p === "execute") queries++; return Reflect.get(t, p, r); } });
      return listPeople({ ...s, tx: counting }, O.project.id);
    });
    const ids = people.map((p) => p.id);
    expect(ids).toContain(u.admin!.id);
    expect(ids).toContain(u.member!.id);
    expect(ids).toContain(u.projectOnly!.id);
    expect(ids).toContain(crowd[0]!.id);
    expect(ids).not.toContain(u.norole!.id);
    expect(ids).not.toContain(u.suspended!.id);
    expect(ids).not.toContain(u.outsider!.id);
    expect(people.length).toBeGreaterThanOrEqual(40);
    expect(queries).toBeLessThan(12); // it used to be three queries per member (> 130 here)
  });
});
