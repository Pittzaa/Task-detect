import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, eq } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { createDepartment, createProject, createTeam, getProject, listDepartments, listProjects } from "@/data/structure";
import { checkRlsEnforceable } from "@/db/client";
import { auditLogs, departments, projects, roleAssignments, memberships, teams } from "@/db/schema";
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

describe("tenant isolation", () => {
  let A: Awaited<ReturnType<typeof makeOrg>>;
  let B: Awaited<ReturnType<typeof makeOrg>>;
  let adminA: { id: string };
  let adminB: { id: string };

  beforeAll(async () => {
    A = await makeOrg(c.admin, "OrgA");
    B = await makeOrg(c.admin, "OrgB");
    adminA = await makeUser(c.admin, "adminA");
    adminB = await makeUser(c.admin, "adminB");
    await addMember(c.admin, A.org.id, adminA.id, { role: "orgadmin" });
    await addMember(c.admin, B.org.id, adminB.id, { role: "orgadmin" });
  });

  it("the runtime role used in these tests is subject to RLS", async () => {
    expect(await checkRlsEnforceable(c.app)).toBeNull();
    expect(await checkRlsEnforceable(c.admin)).toMatch(/superuser|BYPASSRLS/);
  });

  it("an org admin of A cannot open a tenant session for org B (404, not 403)", async () => {
    expect(await code(withTenant(c.app, { userId: adminA.id, orgId: B.org.id }, async (s) => listProjects(s)))).toBe("NOT_FOUND");
  });

  it("listing returns only the caller's org data", async () => {
    const list = await withTenant(c.app, { userId: adminA.id, orgId: A.org.id }, (s) => listProjects(s));
    expect(list.map((p) => p.id)).toEqual([A.project.id]);
  });

  it("fetching another org's project by id is NOT_FOUND from a valid session", async () => {
    expect(await code(withTenant(c.app, { userId: adminA.id, orgId: A.org.id }, (s) => getProject(s, B.project.id)))).toBe("NOT_FOUND");
  });

  it("creating a team under another org's department is NOT_FOUND", async () => {
    expect(
      await code(withTenant(c.app, { userId: adminA.id, orgId: A.org.id }, (s) => createTeam(s, { departmentId: B.dept.id, name: "x" }))),
    ).toBe("NOT_FOUND");
    const bTeams = await c.admin.select().from(teams).where(eq(teams.orgId, B.org.id));
    expect(bTeams.map((t) => t.name)).toEqual(["OrgB Team"]);
  });

  it("writes land in the caller's org and are audited", async () => {
    const created = await withTenant(c.app, { userId: adminA.id, orgId: A.org.id }, (s) => createProject(s, { name: "New A" }));
    const row = (await c.admin.select().from(projects).where(eq(projects.id, created.id)))[0]!;
    expect(row.orgId).toBe(A.org.id);
    const logs = await c.admin.select().from(auditLogs).where(eq(auditLogs.targetId, created.id));
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ orgId: A.org.id, actorUserId: adminA.id, action: "project.create" });
  });

  describe("row-level security as a second layer (queries with NO org filter)", () => {
    it("unfiltered selects only see the session's org", async () => {
      const rows = await c.app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${adminA.id}, true), set_config('app.org_id', ${A.org.id}, true)`);
        return {
          projects: await tx.select().from(projects),
          departments: await tx.select().from(departments),
          teams: await tx.select().from(teams),
          assignments: await tx.select().from(roleAssignments),
        };
      });
      expect(rows.projects.every((r) => r.orgId === A.org.id)).toBe(true);
      expect(rows.departments.every((r) => r.orgId === A.org.id)).toBe(true);
      expect(rows.teams.every((r) => r.orgId === A.org.id)).toBe(true);
      expect(rows.assignments.every((r) => r.orgId === A.org.id)).toBe(true);
      expect(rows.projects.length).toBeGreaterThan(0);
    });

    it("with no context set, nothing is visible", async () => {
      const rows = await c.app.select().from(projects);
      expect(rows).toHaveLength(0);
    });

    it("inserting a row for another org is rejected by the DB", async () => {
      const err = await c.app
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.org_id', ${A.org.id}, true)`);
          await tx.insert(projects).values({ orgId: B.org.id, name: "smuggled" });
        })
        .then(() => null, (e: Error) => e);
      expect(String(err?.cause ?? err)).toMatch(/row-level security/);
    });

    it("updating or deleting another org's rows affects nothing", async () => {
      await c.app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', ${A.org.id}, true)`);
        await tx.update(projects).set({ name: "pwned" }).where(eq(projects.id, B.project.id));
        await tx.delete(projects).where(eq(projects.id, B.project.id));
      });
      const [still] = await c.admin.select().from(projects).where(eq(projects.id, B.project.id));
      expect(still?.name).toBe("OrgB Project");
    });

    it("a user can see their own memberships across orgs but not write to other orgs", async () => {
      const multi = await makeUser(c.admin, "multi");
      await addMember(c.admin, A.org.id, multi.id, { role: "member" });
      await addMember(c.admin, B.org.id, multi.id, { status: "pending" });
      const seen = await c.app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${multi.id}, true)`);
        return tx.select().from(memberships);
      });
      expect(seen.map((m) => m.orgId).sort()).toEqual([A.org.id, B.org.id].sort());

      const escalation = await c.app
        .transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.user_id', ${multi.id}, true)`);
          await tx.update(memberships).set({ status: "approved" }).where(eq(memberships.userId, multi.id));
        })
        .then(() => "ok", () => "err");
      expect(escalation).toBe("ok"); // statement succeeds but matches zero rows (no org context)
      const [m] = await c.admin.select().from(memberships).where(eq(memberships.orgId, B.org.id)).then((r) => r.filter((x) => x.userId === multi.id));
      expect(m?.status).toBe("pending");
    });
  });

  describe("database constraints", () => {
    it("a role assignment cannot reference a team from another org", async () => {
      const m = await addMember(c.admin, A.org.id, (await makeUser(c.admin, "x")).id);
      const roleId = (await c.admin.select().from(roleAssignments).limit(1))[0]!.roleId;
      const err = await c.admin
        .insert(roleAssignments)
        .values({ orgId: A.org.id, membershipId: m.id, roleId, scopeType: "team", teamId: B.team.id })
        .then(() => null, (e: Error) => e);
      expect(String(err?.cause ?? err)).toMatch(/violates foreign key constraint/);
    });

    it("scope_type must match exactly one scope column", async () => {
      const m = await addMember(c.admin, A.org.id, (await makeUser(c.admin, "y")).id);
      const roleId = (await c.admin.select().from(roleAssignments).limit(1))[0]!.roleId;
      const err = await c.admin
        .insert(roleAssignments)
        .values({ orgId: A.org.id, membershipId: m.id, roleId, scopeType: "team", teamId: A.team.id, projectId: A.project.id })
        .then(() => null, (e: Error) => e);
      expect(String(err?.cause ?? err)).toMatch(/role_assignments_scope_matches/);
    });

    it("a team's department must be in the same org", async () => {
      const err = await c.admin
        .insert(teams)
        .values({ orgId: A.org.id, departmentId: B.dept.id, name: "bad" })
        .then(() => null, (e: Error) => e);
      expect(String(err?.cause ?? err)).toMatch(/teams_department_fk/);
    });

    it("the runtime role cannot update or delete audit logs", async () => {
      for (const stmt of [sql`update audit_logs set action = 'tampered'`, sql`delete from audit_logs`]) {
        const err = await c.app.execute(stmt).then(() => null, (e: Error) => e);
        expect(String(err?.cause ?? err)).toMatch(/permission denied/);
      }
    });
  });

  it("the audit log of org A is invisible to org B's session", async () => {
    const rows = await c.app.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.org_id', ${B.org.id}, true)`);
      return tx.select().from(auditLogs);
    });
    expect(rows.every((r) => r.orgId === B.org.id)).toBe(true);
  });

  it("departments created by A are not listed for B", async () => {
    await withTenant(c.app, { userId: adminA.id, orgId: A.org.id }, (s) => createDepartment(s, { name: "A-only" }));
    const names = (await withTenant(c.app, { userId: adminB.id, orgId: B.org.id }, (s) => listDepartments(s))).map((d) => d.name);
    expect(names).not.toContain("A-only");
  });
});
