import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { getContext, listAuditLogs, listPeople } from "@/data/context";
import { createDepartment, getProject, setProjectTeams } from "@/data/structure";
import { createView, getView } from "@/data/views";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; }
}

describe("UI support endpoints", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let O2: Awaited<ReturnType<typeof makeOrg>>;
  const u: Record<string, { id: string; name: string }> = {};
  const as = (k: string, org = O) => ({ userId: u[k]!.id, orgId: org.org.id });

  beforeAll(async () => {
    O = await makeOrg(c.admin, "CtxOrg");
    O2 = await makeOrg(c.admin, "CtxOther");
    for (const k of ["admin", "member", "viewer", "teamMember", "projectViewer", "norole", "outsider", "suspended"]) u[k] = await makeUser(c.admin, k);
    await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
    await addMember(c.admin, O.org.id, u.member!.id, { role: "member" });
    await addMember(c.admin, O.org.id, u.viewer!.id, { role: "viewer" });
    await addMember(c.admin, O.org.id, u.teamMember!.id, { role: "member", scope: { type: "team", id: O.team.id } });
    await addMember(c.admin, O.org.id, u.projectViewer!.id, { role: "viewer", scope: { type: "project", id: O.project.id } });
    await addMember(c.admin, O.org.id, u.norole!.id, {});
    await addMember(c.admin, O.org.id, u.suspended!.id, { status: "suspended", role: "member" });
    await addMember(c.admin, O2.org.id, u.outsider!.id, { role: "orgadmin" });
  });

  describe("getContext (what the UI may show)", () => {
    it("reflects organization-level rights", async () => {
      const admin = await withTenant(c.app, as("admin"), (s) => getContext(s));
      expect(admin.can).toMatchObject({ manageMembers: true, readAuditLog: true, createProject: true, createTask: true });
      const viewer = await withTenant(c.app, as("viewer"), (s) => getContext(s));
      expect(viewer.can).toMatchObject({ manageMembers: false, readAuditLog: false, createProject: false, createTask: false });
      expect(viewer.hasAnyAccess).toBe(true);
    });

    it("a team-scoped member can create tasks even without any organization-wide grant", async () => {
      const ctx = await withTenant(c.app, as("teamMember"), (s) => getContext(s));
      expect(ctx.can.createTask).toBe(true);
      expect(ctx.can.manageMembers).toBe(false);
    });

    it("a project-scoped viewer can read but not create", async () => {
      const ctx = await withTenant(c.app, as("projectViewer"), (s) => getContext(s));
      expect(ctx.hasAnyAccess).toBe(true);
      expect(ctx.can.createTask).toBe(false);
    });

    it("a member with no role has no access at all", async () => {
      const ctx = await withTenant(c.app, as("norole"), (s) => getContext(s));
      expect(ctx.hasAnyAccess).toBe(false);
      expect(Object.values(ctx.can).some(Boolean)).toBe(false);
    });

    it("does not exist for a suspended member or for someone from another organization", async () => {
      expect(await code(withTenant(c.app, as("suspended"), (s) => getContext(s)))).toBe("NOT_FOUND");
      expect(await code(withTenant(c.app, { userId: u.outsider!.id, orgId: O.org.id }, (s) => getContext(s)))).toBe("NOT_FOUND");
    });
  });

  describe("listPeople (assignee / mention pickers)", () => {
    it("lists only approved members who can read the project, never other tenants, suspended or role-less members", async () => {
      const people = await withTenant(c.app, as("admin"), (s) => listPeople(s, O.project.id));
      const ids = people.map((p) => p.id);
      expect(ids).toEqual(expect.arrayContaining([u.admin!.id, u.member!.id, u.viewer!.id, u.projectViewer!.id]));
      expect(ids).not.toContain(u.norole!.id);
      expect(ids).not.toContain(u.suspended!.id);
      expect(ids).not.toContain(u.outsider!.id);
      expect(Object.keys(people[0]!).sort()).toEqual(["id", "name"]); // names only, never emails
    });

    it("a team-scoped member is listed only once the team participates in the project", async () => {
      const before = (await withTenant(c.app, as("admin"), (s) => listPeople(s, O.project.id))).map((p) => p.id);
      expect(before).not.toContain(u.teamMember!.id);
      await withTenant(c.app, as("admin"), (s) => setProjectTeams(s, O.project.id, [O.team.id]));
      const after = (await withTenant(c.app, as("admin"), (s) => listPeople(s, O.project.id))).map((p) => p.id);
      expect(after).toContain(u.teamMember!.id);
      await withTenant(c.app, as("admin"), (s) => setProjectTeams(s, O.project.id, []));
    });

    it("someone who cannot read the project gets NOT_FOUND, as does an unknown or foreign project", async () => {
      expect(await code(withTenant(c.app, as("norole"), (s) => listPeople(s, O.project.id)))).toBe("NOT_FOUND");
      expect(await code(withTenant(c.app, as("admin"), (s) => listPeople(s, O2.project.id)))).toBe("NOT_FOUND");
      expect(await code(withTenant(c.app, as("admin"), (s) => listPeople(s, "00000000-0000-4000-8000-000000000000")))).toBe("NOT_FOUND");
    });
  });

  describe("getProject.teamIds", () => {
    it("returns the participating teams", async () => {
      await withTenant(c.app, as("admin"), (s) => setProjectTeams(s, O.project.id, [O.team.id]));
      const p = await withTenant(c.app, as("admin"), (s) => getProject(s, O.project.id));
      expect(p.teamIds).toEqual([O.team.id]);
      await withTenant(c.app, as("admin"), (s) => setProjectTeams(s, O.project.id, []));
      expect((await withTenant(c.app, as("admin"), (s) => getProject(s, O.project.id))).teamIds).toEqual([]);
    });
  });

  describe("listAuditLogs", () => {
    it("requires the audit permission and is scoped to the organization", async () => {
      await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Audited dept" }));
      await withTenant(c.app, { userId: u.outsider!.id, orgId: O2.org.id }, (s) => createDepartment(s, { name: "Other tenant dept" }));
      const page = await withTenant(c.app, as("admin"), (s) => listAuditLogs(s));
      expect(page.items.some((i) => i.action === "department.create" && i.actorId === u.admin!.id)).toBe(true);
      expect(page.items.every((i) => i.actorId !== u.outsider!.id)).toBe(true);
      expect(await code(withTenant(c.app, as("member"), (s) => listAuditLogs(s)))).toBe("FORBIDDEN");
      expect(await code(withTenant(c.app, as("viewer"), (s) => listAuditLogs(s)))).toBe("FORBIDDEN");
    });

    it("filters by action prefix without treating LIKE wildcards as patterns, and paginates", async () => {
      const wild = await withTenant(c.app, as("admin"), (s) => listAuditLogs(s, { action: "%" }));
      expect(wild.items).toHaveLength(0);
      const dept = await withTenant(c.app, as("admin"), (s) => listAuditLogs(s, { action: "department." }));
      expect(dept.items.length).toBeGreaterThan(0);
      expect(dept.items.every((i) => i.action.startsWith("department."))).toBe(true);
      const one = await withTenant(c.app, as("admin"), (s) => listAuditLogs(s, { limit: 1 }));
      expect(one.items).toHaveLength(1);
      expect(one.hasMore).toBe(true);
      const clamped = await withTenant(c.app, as("admin"), (s) => listAuditLogs(s, { limit: 10_000 }));
      expect(clamped.items.length).toBeLessThanOrEqual(100);
    });
  });

  describe("getView", () => {
    it("returns the saved definition with an editable flag for the owner only; other tenants cannot see it", async () => {
      const v = await withTenant(c.app, as("member"), (s) => createView(s, { name: "Mine", kind: "list", scope: "personal", filter: { status: ["todo"] } }));
      const own = await withTenant(c.app, as("member"), (s) => getView(s, v.id));
      expect(own).toMatchObject({ id: v.id, name: "Mine", scope: "personal", editable: true });
      expect(await code(withTenant(c.app, as("viewer"), (s) => getView(s, v.id)))).toBe("NOT_FOUND"); // personal views are visible to their owner only
      expect(await code(withTenant(c.app, { userId: u.outsider!.id, orgId: O2.org.id }, (s) => getView(s, v.id)))).toBe("NOT_FOUND");
    });
  });
});
