import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { createDepartment, createProject, createTeam, getProject, listProjects } from "@/data/structure";
import { auditLogs } from "@/db/schema";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

async function code(p: Promise<unknown>) {
  try {
    await p;
    return "OK";
  } catch (e) {
    return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`;
  }
}

describe("server-side RBAC", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let O2: Awaited<ReturnType<typeof makeOrg>>;
  const u: Record<string, { id: string }> = {};

  beforeAll(async () => {
    O = await makeOrg(c.admin, "RbacOrg");
    O2 = await makeOrg(c.admin, "OtherOrg");
    for (const k of ["admin", "manager", "member", "viewer", "norole", "pending", "suspended", "revoked", "teamMgr", "otherAdmin"]) {
      u[k] = await makeUser(c.admin, k);
    }
    await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
    await addMember(c.admin, O.org.id, u.manager!.id, { role: "manager" });
    await addMember(c.admin, O.org.id, u.member!.id, { role: "member" });
    await addMember(c.admin, O.org.id, u.viewer!.id, { role: "viewer" });
    await addMember(c.admin, O.org.id, u.norole!.id, {});
    await addMember(c.admin, O.org.id, u.pending!.id, { status: "pending", role: "orgadmin" });
    await addMember(c.admin, O.org.id, u.suspended!.id, { status: "suspended", role: "orgadmin" });
    await addMember(c.admin, O.org.id, u.revoked!.id, { status: "revoked", role: "orgadmin" });
    await addMember(c.admin, O.org.id, u.teamMgr!.id, { role: "manager", scope: { type: "team", id: O.team.id } });
    await addMember(c.admin, O2.org.id, u.otherAdmin!.id, { role: "orgadmin" });
  });

  const as = (k: string) => ({ userId: u[k]!.id, orgId: O.org.id });

  describe("account states", () => {
    it.each(["pending", "suspended", "revoked"])("a %s member cannot reach any org data", async (k) => {
      expect(await code(withTenant(c.app, as(k), (s) => listProjects(s)))).toBe("NOT_FOUND");
      expect(await code(withTenant(c.app, as(k), (s) => createProject(s, { name: "x" })))).toBe("NOT_FOUND");
    });

    it("a non-member (admin of another org) gets NOT_FOUND", async () => {
      expect(await code(withTenant(c.app, { userId: u.otherAdmin!.id, orgId: O.org.id }, (s) => listProjects(s)))).toBe("NOT_FOUND");
    });

    it("an approved member with no role assignment is denied (deny by default)", async () => {
      expect(await code(withTenant(c.app, as("norole"), (s) => listProjects(s)))).toBe("FORBIDDEN");
    });
  });

  describe("permission matrix (positive and negative)", () => {
    const cases: Array<[role: string, action: string, run: (s: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<unknown>, expected: "OK" | "FORBIDDEN"]> = [
      ["viewer", "read projects", (s) => listProjects(s), "OK"],
      ["viewer", "read a project", (s) => getProject(s, O.project.id), "OK"],
      ["viewer", "create project", (s) => createProject(s, { name: "v" }), "FORBIDDEN"],
      ["viewer", "create department", (s) => createDepartment(s, { name: "v" }), "FORBIDDEN"],
      ["member", "read projects", (s) => listProjects(s), "OK"],
      ["member", "create project", (s) => createProject(s, { name: "m" }), "FORBIDDEN"],
      ["member", "create department", (s) => createDepartment(s, { name: "m" }), "FORBIDDEN"],
      ["manager", "create project", (s) => createProject(s, { name: "mg" }), "OK"],
      ["manager", "create department", (s) => createDepartment(s, { name: "mg" }), "FORBIDDEN"],
      ["manager", "create team", (s) => createTeam(s, { departmentId: O.dept.id, name: "mg" }), "FORBIDDEN"],
      ["admin", "create project", (s) => createProject(s, { name: "ad" }), "OK"],
      ["admin", "create department", (s) => createDepartment(s, { name: "ad" }), "OK"],
      ["admin", "create team", (s) => createTeam(s, { departmentId: O.dept.id, name: "ad" }), "OK"],
    ];
    it.each(cases)("%s: %s -> %s", async (role, _action, run, expected) => {
      expect(await code(withTenant(c.app, as(role), run))).toBe(expected);
    });
  });

  describe("scope limits", () => {
    it("a manager scoped to one team has no org-wide project access", async () => {
      expect(await code(withTenant(c.app, as("teamMgr"), (s) => listProjects(s)))).toBe("FORBIDDEN");
      expect(await code(withTenant(c.app, as("teamMgr"), (s) => createProject(s, { name: "t" })))).toBe("FORBIDDEN");
      expect(await code(withTenant(c.app, as("teamMgr"), (s) => getProject(s, O.project.id)))).toBe("FORBIDDEN");
    });

    it("the same team-scoped manager is allowed inside their own team scope", async () => {
      const allowed = await withTenant(c.app, as("teamMgr"), async (s) => {
        s.require("task.update", { teamId: O.team.id });
        return true;
      });
      expect(allowed).toBe(true);
      expect(await code(withTenant(c.app, as("teamMgr"), async (s) => s.require("task.update", { teamId: "00000000-0000-0000-0000-000000000000" })))).toBe("FORBIDDEN");
    });
  });

  describe("denials", () => {
    it("are audited with the permission name and no record content", async () => {
      await code(withTenant(c.app, as("viewer"), (s) => createProject(s, { name: "SECRET-PROJECT-NAME" })));
      const logs = await c.admin
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.actorUserId, u.viewer!.id), eq(auditLogs.action, "authz.denied")));
      expect(logs.length).toBeGreaterThan(0);
      expect(logs[0]!.metadata).toEqual({ permission: "project.create" });
      expect(JSON.stringify(logs)).not.toContain("SECRET-PROJECT-NAME");
    });

    it("a denied write is rolled back", async () => {
      await code(withTenant(c.app, as("viewer"), (s) => createProject(s, { name: "should-not-exist" })));
      const rows = await withTenant(c.app, as("admin"), (s) => listProjects(s));
      expect(rows.map((r) => r.name)).not.toContain("should-not-exist");
    });

    it("surface a generic error to the caller", async () => {
      try {
        await withTenant(c.app, as("viewer"), (s) => createProject(s, { name: "x" }));
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(AppError);
        expect((e as AppError).message).toBe("Not allowed");
        expect((e as AppError).detail).toBeUndefined();
      }
    });
  });
});
