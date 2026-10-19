import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { createDepartment, createProject, createTeam, deleteDepartment, deleteProject, deleteTeam, getProject, listDepartments, listProjects, listTeams, setProjectTeams } from "@/data/structure";
import { createTask, listTasks } from "@/data/tasks";
import { assignRole } from "@/data/account";
import { createDestination } from "@/data/integrations";
import {
  auditLogs, departments, integrationDestinations, memberships, outboxEvents, projectTeams, projects, recurrenceSeries, roleAssignments, savedViews, tasks, teams, users,
} from "@/db/schema";
import * as deptRoute from "@/app/api/orgs/[orgId]/departments/[departmentId]/route";
import * as teamRoute from "@/app/api/orgs/[orgId]/teams/[teamId]/route";
import * as projectRoute from "@/app/api/orgs/[orgId]/projects/[projectId]/route";
import { addMember, connect, makeOrg, makeUser, systemRoleId } from "./helpers";
import { makeAuthApp, registerAndSignIn } from "./auth-helpers";

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

/** Deleting needs the thing's name typed; unless a test is about that, it types the right one. */
const nameOf = async (kind: "d" | "t" | "p", id: string) => {
  const rows = kind === "d" ? await c.admin.select({ n: departments.name }).from(departments).where(eq(departments.id, id))
    : kind === "t" ? await c.admin.select({ n: teams.name }).from(teams).where(eq(teams.id, id))
    : await c.admin.select({ n: projects.name }).from(projects).where(eq(projects.id, id));
  return rows[0]?.n ?? "(no such thing)";
};
type Ctx = { userId: string; orgId: string };
const delDept = (ctx: Ctx, id: string, typed?: string) => withTenant(c.app, ctx, async (s) => deleteDepartment(s, id, typed ?? (await nameOf("d", id))));
const delTeam = (ctx: Ctx, id: string, typed?: string) => withTenant(c.app, ctx, async (s) => deleteTeam(s, id, typed ?? (await nameOf("t", id))));
const delProject = (ctx: Ctx, id: string, typed?: string) => withTenant(c.app, ctx, async (s) => deleteProject(s, id, typed ?? (await nameOf("p", id))));

describe("deleting departments, teams and projects", () => {
  let O: Awaited<ReturnType<typeof makeOrg>>;
  let O2: Awaited<ReturnType<typeof makeOrg>>;
  const u: Record<string, { id: string }> = {};
  const as = (k: string) => ({ userId: u[k]!.id, orgId: O.org.id });

  // a second department with its own team, to prove neighbours are left alone
  let dept2: { id: string };
  let team2: { id: string };
  let team1b: { id: string };

  beforeAll(async () => {
    O = await makeOrg(c.admin, "DelOrg");
    O2 = await makeOrg(c.admin, "DelOther");
    for (const k of ["admin", "manager", "member", "viewer", "norole", "deptAdmin", "teamAdmin", "otherAdmin"]) u[k] = await makeUser(c.admin, k);
    await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
    await addMember(c.admin, O.org.id, u.manager!.id, { role: "manager" });
    await addMember(c.admin, O.org.id, u.member!.id, { role: "member" });
    await addMember(c.admin, O.org.id, u.viewer!.id, { role: "viewer" });
    await addMember(c.admin, O.org.id, u.norole!.id, {});
    await addMember(c.admin, O.org.id, u.deptAdmin!.id, { role: "orgadmin", scope: { type: "department", id: O.dept.id } });
    await addMember(c.admin, O.org.id, u.teamAdmin!.id, { role: "orgadmin", scope: { type: "team", id: O.team.id } });
    await addMember(c.admin, O2.org.id, u.otherAdmin!.id, { role: "orgadmin" });
    dept2 = (await c.admin.insert(departments).values({ orgId: O.org.id, name: "Second department" }).returning({ id: departments.id }))[0]!;
    team2 = (await c.admin.insert(teams).values({ orgId: O.org.id, departmentId: dept2.id, name: "Second team" }).returning({ id: teams.id }))[0]!;
    team1b = (await c.admin.insert(teams).values({ orgId: O.org.id, departmentId: O.dept.id, name: "Another team in the first department" }).returning({ id: teams.id }))[0]!;
  });

  async function seedTeamLinks(teamId: string, projectId: string) {
    await c.admin.insert(projectTeams).values({ orgId: O.org.id, projectId, teamId }).onConflictDoNothing();
    const [view] = await c.admin.insert(savedViews).values({ orgId: O.org.id, ownerId: u.admin!.id, name: "Team view", scope: "team", teamId }).returning({ id: savedViews.id });
    const [dest] = await c.admin.insert(integrationDestinations).values({
      orgId: O.org.id, teamId, name: "Team channel", webhookCiphertext: "ciphertext", webhookHint: "abcd", events: ["task.created"], createdBy: u.admin!.id,
    }).returning({ id: integrationDestinations.id });
    return { viewId: view!.id, destId: dest!.id };
  }

  describe("permissions", () => {
    it.each(["manager", "member", "viewer", "norole", "deptAdmin", "teamAdmin"])("%s cannot delete a department", async (k) => {
      const r = await code(delDept(as(k), O.dept.id));
      expect(["FORBIDDEN", "NOT_FOUND"]).toContain(r);
      const [row] = await c.admin.select({ deletedAt: departments.deletedAt }).from(departments).where(eq(departments.id, O.dept.id));
      expect(row!.deletedAt).toBeNull();
    });

    it.each(["manager", "member", "viewer", "norole", "teamAdmin"])("%s cannot delete a team", async (k) => {
      const r = await code(delTeam(as(k), O.team.id));
      expect(["FORBIDDEN", "NOT_FOUND"]).toContain(r);
      const [row] = await c.admin.select({ deletedAt: teams.deletedAt }).from(teams).where(eq(teams.id, O.team.id));
      expect(row!.deletedAt).toBeNull();
    });

    it.each(["manager", "member", "viewer", "norole"])("%s cannot delete a project", async (k) => {
      const r = await code(delProject(as(k), O.project.id));
      expect(["FORBIDDEN", "NOT_FOUND"]).toContain(r);
      const [row] = await c.admin.select({ deletedAt: projects.deletedAt }).from(projects).where(eq(projects.id, O.project.id));
      expect(row!.deletedAt).toBeNull();
    });

    it("a department administrator cannot delete a team of another department", async () => {
      const r = await code(delTeam(as("deptAdmin"), team2.id));
      expect(["FORBIDDEN", "NOT_FOUND"]).toContain(r);
      const [row] = await c.admin.select({ deletedAt: teams.deletedAt }).from(teams).where(eq(teams.id, team2.id));
      expect(row!.deletedAt).toBeNull();
    });

    it("an administrator of another organization cannot reach this organization's structure at all", async () => {
      const ctx = { userId: u.otherAdmin!.id, orgId: O.org.id };
      expect(await code(delDept(ctx, O.dept.id))).toBe("NOT_FOUND");
      expect(await code(delTeam(ctx, O.team.id))).toBe("NOT_FOUND");
      expect(await code(delProject(ctx, O.project.id))).toBe("NOT_FOUND");
    });

    it("an administrator cannot delete another organization's structure by passing its ids to their own organization", async () => {
      expect(await code(delDept(as("admin"), O2.dept.id))).toBe("NOT_FOUND");
      expect(await code(delTeam(as("admin"), O2.team.id))).toBe("NOT_FOUND");
      expect(await code(delProject(as("admin"), O2.project.id))).toBe("NOT_FOUND");
      const rows = await c.admin.select({ d: departments.deletedAt }).from(departments).where(eq(departments.orgId, O2.org.id));
      expect(rows.every((r) => r.d === null)).toBe(true);
      const t = await c.admin.select({ d: teams.deletedAt }).from(teams).where(eq(teams.orgId, O2.org.id));
      expect(t.every((r) => r.d === null)).toBe(true);
      const p = await c.admin.select({ d: projects.deletedAt }).from(projects).where(eq(projects.orgId, O2.org.id));
      expect(p.every((r) => r.d === null)).toBe(true);
    });

    it("a department administrator may delete a team inside their own department", async () => {
      const [made] = await c.admin.insert(teams).values({ orgId: O.org.id, departmentId: O.dept.id, name: "Disposable" }).returning({ id: teams.id });
      expect(await code(delTeam(as("deptAdmin"), made!.id))).toBe("OK");
    });
  });

  describe("typed confirmation", () => {
    it("a wrong, empty, other or differently cased name deletes nothing, for all three kinds", async () => {
      const d = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Typed Dept" }));
      const t = await withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d.id, name: "Typed Team" }));
      const p = await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Typed Project" }));
      const wrong = ["", "   ", "typed dept", "Typed Dep", "Typed Team", "Typed Project", O.dept.name, "Typed Dept!", "Typed\u200b Dept"];
      for (const typed of wrong) expect(await code(delDept(as("admin"), d.id, typed)), `dept ${JSON.stringify(typed)}`).toBe("VALIDATION");
      for (const typed of ["", "typed team", "Typed Dept", "Typed Teams"]) expect(await code(delTeam(as("admin"), t.id, typed)), `team ${JSON.stringify(typed)}`).toBe("VALIDATION");
      for (const typed of ["", "typed project", "Typed Team", "Typed Projec"]) expect(await code(delProject(as("admin"), p.id, typed)), `project ${JSON.stringify(typed)}`).toBe("VALIDATION");
      const [dr] = await c.admin.select({ d: departments.deletedAt }).from(departments).where(eq(departments.id, d.id));
      const [tr] = await c.admin.select({ d: teams.deletedAt }).from(teams).where(eq(teams.id, t.id));
      const [pr] = await c.admin.select({ d: projects.deletedAt }).from(projects).where(eq(projects.id, p.id));
      expect([dr!.d, tr!.d, pr!.d]).toEqual([null, null, null]);
      expect((await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), inArray(auditLogs.targetId, [d.id, t.id, p.id]), inArray(auditLogs.action, ["department.delete", "team.delete", "project.delete"])))).length).toBe(0);
      // the right name works, with sloppy spacing and in another Unicode form of the same text
      expect(await code(delTeam(as("admin"), t.id, "  Typed   Team "))).toBe("OK");
      expect(await code(delProject(as("admin"), p.id, "Typed Project"))).toBe("OK");
      expect(await code(delDept(as("admin"), d.id, "Typed Dept"))).toBe("OK");
    });

    it("a name that needs normalizing is accepted in either Unicode form", async () => {
      const d = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Caf\u00e9 team" }));
      expect(await code(delDept(as("admin"), d.id, "Cafe\u0301 team"))).toBe("OK");
    });

    it("the permission is judged first: someone who may not delete learns nothing about whether the name matched", async () => {
      expect(await code(delDept(as("member"), O.dept.id, "definitely not the name"))).toBe("FORBIDDEN");
      expect(await code(delTeam(as("member"), O.team.id, "definitely not the name"))).toBe("FORBIDDEN");
      expect(await code(delProject(as("member"), O.project.id, "definitely not the name"))).toBe("FORBIDDEN");
    });

    it("over HTTP the name is required in the body: none, an empty body, extra fields and a wrong name are all 422 and change nothing", async () => {
      const authApp = makeAuthApp(c.app);
      const { client, email } = await registerAndSignIn(authApp, "typedadmin");
      const [au] = await c.admin.select({ id: users.id }).from(users).where(eq(users.email, email));
      await addMember(c.admin, O.org.id, au!.id, { role: "orgadmin" });
      const d = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Http Dept" }));
      const t = await withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d.id, name: "Http Team" }));
      const p = await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Http Project" }));
      const call = (handler: unknown, path: string, params: Record<string, string>, body?: unknown) =>
        client.route(handler as never, "DELETE", path, body, { orgId: O.org.id, ...params }).then((r) => r.status);
      const dPath = `/api/orgs/${O.org.id}/departments/${d.id}`;
      const tPath = `/api/orgs/${O.org.id}/teams/${t.id}`;
      const pPath = `/api/orgs/${O.org.id}/projects/${p.id}`;
      for (const body of [undefined, {}, { confirm: "" }, { confirm: "nope" }, { confirm: 5 }, { confirm: "Http Dept", extra: true }, { confirm: "x".repeat(301) }]) {
        expect(await call(deptRoute.DELETE, dPath, { departmentId: d.id }, body), JSON.stringify(body)).toBe(422);
      }
      expect(await call(teamRoute.DELETE, tPath, { teamId: t.id })).toBe(422);
      expect(await call(teamRoute.DELETE, tPath, { teamId: t.id }, { confirm: "Http Dept" })).toBe(422);
      expect(await call(projectRoute.DELETE, pPath, { projectId: p.id })).toBe(422);
      expect(await call(projectRoute.DELETE, pPath, { projectId: p.id }, { confirm: "http project" })).toBe(422);
      const live = await c.admin.select({ d: departments.deletedAt }).from(departments).where(eq(departments.id, d.id));
      expect(live[0]!.d).toBeNull();
      expect(await call(teamRoute.DELETE, tPath, { teamId: t.id }, { confirm: "Http Team" })).toBe(200);
      expect(await call(projectRoute.DELETE, pPath, { projectId: p.id }, { confirm: "Http Project" })).toBe(200);
      expect(await call(deptRoute.DELETE, dPath, { departmentId: d.id }, { confirm: "Http Dept" })).toBe(200);
      // gone: a repeat is a 404, even with the right name
      expect(await call(deptRoute.DELETE, dPath, { departmentId: d.id }, { confirm: "Http Dept" })).toBe(404);
    });
  });

  describe("creating something under a thing while it is being deleted", () => {
    /** Runs `fn` in a tenant transaction and keeps the transaction open until `release()` is called. */
    function held<T>(ctx: Ctx, fn: (s: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) {
      let release!: () => void;
      let reached!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const didWork = new Promise<void>((r) => { reached = r; });
      const done = withTenant(c.app, ctx, async (s) => { const out = await fn(s); reached(); await gate; return out; });
      return { done, release, didWork };
    }
    const stillWaiting = async (p: Promise<unknown>) => {
      const settled = await Promise.race([p.then(() => "settled", () => "settled"), new Promise<string>((r) => setTimeout(() => r("waiting"), 400))]);
      return settled === "waiting";
    };

    it("a team cannot be added to a department whose deletion is in progress, nor survive a deletion that starts after it", async () => {
      // deletion first
      const d1 = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Race dept 1" }));
      const del = held(as("admin"), (s) => deleteDepartment(s, d1.id, "Race dept 1"));
      await del.didWork;
      const create = withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d1.id, name: "Late team" }));
      expect(await stillWaiting(create)).toBe(true);
      del.release();
      await del.done;
      expect(await code(create)).toBe("NOT_FOUND");
      expect(await c.admin.select().from(teams).where(and(eq(teams.departmentId, d1.id), isNull(teams.deletedAt)))).toHaveLength(0);

      // creation first: the deletion waits for it and then takes the new team along
      const d2 = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Race dept 2" }));
      const make = held(as("admin"), (s) => createTeam(s, { departmentId: d2.id, name: "Early team" }));
      await make.didWork;
      const remove = delDept(as("admin"), d2.id);
      expect(await stillWaiting(remove)).toBe(true);
      make.release();
      await make.done;
      expect(await remove).toMatchObject({ teams: 1 });
      expect(await c.admin.select().from(teams).where(and(eq(teams.departmentId, d2.id), isNull(teams.deletedAt)))).toHaveLength(0);
    });

    it("a task cannot be created in a project whose deletion is in progress, and one created just before is deleted with it", async () => {
      const p1 = await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Race project 1" }));
      const del = held(as("admin"), (s) => deleteProject(s, p1.id, "Race project 1"));
      await del.didWork;
      const create = withTenant(c.app, as("admin"), (s) => createTask(s, { projectId: p1.id, title: "Late task" }));
      expect(await stillWaiting(create)).toBe(true);
      del.release();
      await del.done;
      expect(await code(create)).toBe("NOT_FOUND");
      expect(await c.admin.select().from(tasks).where(and(eq(tasks.projectId, p1.id), isNull(tasks.deletedAt)))).toHaveLength(0);

      const p2 = await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Race project 2" }));
      const make = held(as("admin"), (s) => createTask(s, { projectId: p2.id, title: "Early task" }));
      await make.didWork;
      const remove = delProject(as("admin"), p2.id);
      expect(await stillWaiting(remove)).toBe(true);
      make.release();
      await make.done;
      expect(await remove).toMatchObject({ tasks: 1 });
      expect(await c.admin.select().from(tasks).where(and(eq(tasks.projectId, p2.id), isNull(tasks.deletedAt)))).toHaveLength(0);
    });

    it("a role cannot be given for a team being deleted, and one given just before is removed with the team", async () => {
      const member = await makeUser(c.admin, "racer");
      const [mem] = await c.admin.insert(memberships).values({ orgId: O.org.id, userId: member.id, status: "approved" }).returning({ id: memberships.id });
      const roleId = await systemRoleId(c.admin, "member");
      const d = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Race dept 3" }));
      const t1 = await withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d.id, name: "Race team 1" }));
      const del = held(as("admin"), (s) => deleteTeam(s, t1.id, "Race team 1"));
      await del.didWork;
      const give = withTenant(c.app, as("admin"), (s) => assignRole(s, { membershipId: mem!.id, roleId, scope: { type: "team", id: t1.id } }));
      expect(await stillWaiting(give)).toBe(true);
      del.release();
      await del.done;
      expect(await code(give)).toBe("NOT_FOUND");
      expect(await c.admin.select().from(roleAssignments).where(eq(roleAssignments.teamId, t1.id))).toHaveLength(0);

      const t2 = await withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d.id, name: "Race team 2" }));
      const grant = held(as("admin"), (s) => assignRole(s, { membershipId: mem!.id, roleId, scope: { type: "team", id: t2.id } }));
      await grant.didWork;
      const remove = delTeam(as("admin"), t2.id);
      expect(await stillWaiting(remove)).toBe(true);
      grant.release();
      await grant.done;
      await remove;
      expect(await c.admin.select().from(roleAssignments).where(eq(roleAssignments.teamId, t2.id))).toHaveLength(0);
    });

    it("a team cannot be linked to a project, and a Discord channel cannot be created for a team or project, while that thing is being deleted", async () => {
      const d = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Race dept 4" }));
      const t = await withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d.id, name: "Race team 3" }));
      const p = await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Race project 3" }));
      const del = held(as("admin"), (s) => deleteTeam(s, t.id, "Race team 3"));
      await del.didWork;
      const link = withTenant(c.app, as("admin"), (s) => setProjectTeams(s, p.id, [t.id]));
      const dest = withTenant(c.app, as("admin"), (s) => createDestination(s, { encryptionKeys: [Buffer.alloc(32, 3).toString("base64")] } as never, { name: "Chan", teamId: t.id, events: ["task.created"], webhookUrl: `https://discord.com/api/webhooks/123456789012345678/${"a".repeat(40)}` } as never));
      expect(await stillWaiting(link)).toBe(true);
      expect(await stillWaiting(dest)).toBe(true);
      del.release();
      await del.done;
      expect(await code(link)).toBe("NOT_FOUND");
      expect(await code(dest)).toBe("NOT_FOUND");
      expect(await c.admin.select().from(projectTeams).where(eq(projectTeams.teamId, t.id))).toHaveLength(0);
      expect(await c.admin.select().from(integrationDestinations).where(and(eq(integrationDestinations.teamId, t.id), isNull(integrationDestinations.deletedAt)))).toHaveLength(0);

      const del2 = held(as("admin"), (s) => deleteProject(s, p.id, "Race project 3"));
      await del2.didWork;
      const dest2 = withTenant(c.app, as("admin"), (s) => createDestination(s, { encryptionKeys: [Buffer.alloc(32, 3).toString("base64")] } as never, { name: "Chan2", projectId: p.id, events: ["task.created"], webhookUrl: `https://discord.com/api/webhooks/123456789012345678/${"b".repeat(40)}` } as never));
      expect(await stillWaiting(dest2)).toBe(true);
      del2.release();
      await del2.done;
      expect(await code(dest2)).toBe("NOT_FOUND");
    });
  });

  describe("a team", () => {
    it("is hidden everywhere and everything that pointed at it is cleaned up; its neighbours are untouched", async () => {
      const proj = (await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Shared by two teams" }))).id;
      const keep = await seedTeamLinks(team1b.id, proj);
      const gone = await seedTeamLinks(O.team.id, proj);
      // role assignments scoped to the team, and one scoped elsewhere that must survive
      const teamMember = await makeUser(c.admin, "teammember");
      await addMember(c.admin, O.org.id, teamMember.id, { role: "member", scope: { type: "team", id: O.team.id } });
      const survivor = await makeUser(c.admin, "survivor");
      await addMember(c.admin, O.org.id, survivor.id, { role: "member", scope: { type: "team", id: team1b.id } });

      const before = await c.admin.select({ n: roleAssignments.id }).from(roleAssignments).where(eq(roleAssignments.teamId, O.team.id));
      expect(before.length).toBeGreaterThan(0);

      await delTeam(as("admin"), O.team.id);

      const listed = await withTenant(c.app, as("admin"), (s) => listTeams(s));
      expect(listed.map((t) => t.id)).not.toContain(O.team.id);
      expect(listed.map((t) => t.id)).toContain(team1b.id);
      expect(listed.map((t) => t.id)).toContain(team2.id);

      expect(await c.admin.select().from(roleAssignments).where(eq(roleAssignments.teamId, O.team.id))).toHaveLength(0);
      expect((await c.admin.select().from(roleAssignments).where(eq(roleAssignments.teamId, team1b.id))).length).toBeGreaterThan(0);
      expect(await c.admin.select().from(projectTeams).where(eq(projectTeams.teamId, O.team.id))).toHaveLength(0);
      expect(await c.admin.select().from(projectTeams).where(eq(projectTeams.teamId, team1b.id))).toHaveLength(1);

      const [gv] = await c.admin.select({ d: savedViews.deletedAt }).from(savedViews).where(eq(savedViews.id, gone.viewId));
      const [kv] = await c.admin.select({ d: savedViews.deletedAt }).from(savedViews).where(eq(savedViews.id, keep.viewId));
      expect(gv!.d).not.toBeNull();
      expect(kv!.d).toBeNull();
      const [gd] = await c.admin.select().from(integrationDestinations).where(eq(integrationDestinations.id, gone.destId));
      const [kd] = await c.admin.select().from(integrationDestinations).where(eq(integrationDestinations.id, keep.destId));
      expect(gd!.deletedAt).not.toBeNull();
      expect(gd!.enabled).toBe(false);
      expect(gd!.webhookCiphertext).toBe("destroyed");
      expect(kd!.deletedAt).toBeNull();
      expect(kd!.webhookCiphertext).toBe("ciphertext");

      // the project itself and its tasks are still there
      const p = await withTenant(c.app, as("admin"), (s) => getProject(s, proj));
      expect(p.teamIds).toEqual([team1b.id]);

      const [audit] = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "team.delete"), eq(auditLogs.targetId, O.team.id)));
      expect(audit).toBeTruthy();
      expect(audit!.actorUserId).toBe(u.admin!.id);
      // what the deletion took away is on record: counts, and one role.unassign entry per access that was removed
      expect(audit!.metadata).toMatchObject({ assignments: before.length, projectLinks: 1, views: 1, destinations: 1 });
      const unassigned = (await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "role.unassign")))).filter((a) => (a.metadata as { via?: string; scopeId?: string }).via === "team.delete" && (a.metadata as { scopeId?: string }).scopeId === O.team.id);
      expect(unassigned).toHaveLength(before.length);
      expect(unassigned.every((a) => (a.metadata as { scopeId: string }).scopeId === O.team.id && typeof (a.metadata as { membershipId: string }).membershipId === "string")).toBe(true);
      expect(new Set(unassigned.map((a) => a.targetId))).toEqual(new Set(before.map((b) => b.n)));
    });

    it("cannot be deleted twice, and a deleted team cannot be given to a project again", async () => {
      expect(await code(delTeam(as("admin"), O.team.id))).toBe("NOT_FOUND");
      expect(await code(withTenant(c.app, as("admin"), (s) => setProjectTeams(s, O.project.id, [O.team.id])))).toBe("NOT_FOUND");
    });
  });

  describe("a department", () => {
    it("takes its teams with it and leaves other departments, their teams and all projects alone", async () => {
      const d = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "To be removed" }));
      const t1 = await withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d.id, name: "T1" }));
      const t2 = await withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d.id, name: "T2" }));
      const proj = (await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Spans departments" }))).id;
      await seedTeamLinks(t1.id, proj);
      await c.admin.insert(projectTeams).values({ orgId: O.org.id, projectId: proj, teamId: team2.id });
      const deptMember = await makeUser(c.admin, "deptmember");
      await addMember(c.admin, O.org.id, deptMember.id, { role: "member", scope: { type: "department", id: d.id } });
      const teamMember = await makeUser(c.admin, "t2member");
      await addMember(c.admin, O.org.id, teamMember.id, { role: "member", scope: { type: "team", id: t2.id } });

      const res = await delDept(as("admin"), d.id);
      expect(res.teams).toBe(2);

      expect((await withTenant(c.app, as("admin"), (s) => listDepartments(s))).map((x) => x.id)).not.toContain(d.id);
      const live = (await withTenant(c.app, as("admin"), (s) => listTeams(s))).map((x) => x.id);
      expect(live).not.toContain(t1.id);
      expect(live).not.toContain(t2.id);
      expect(live).toContain(team2.id);

      expect(await c.admin.select().from(roleAssignments).where(eq(roleAssignments.departmentId, d.id))).toHaveLength(0);
      expect(await c.admin.select().from(roleAssignments).where(inArray(roleAssignments.teamId, [t1.id, t2.id]))).toHaveLength(0);
      expect(await c.admin.select().from(projectTeams).where(inArray(projectTeams.teamId, [t1.id, t2.id]))).toHaveLength(0);
      expect(await c.admin.select().from(projectTeams).where(eq(projectTeams.teamId, team2.id))).toHaveLength(1);

      const rows = await c.admin.select({ id: teams.id, d: teams.deletedAt }).from(teams).where(inArray(teams.id, [t1.id, t2.id, team2.id]));
      expect(rows.find((r) => r.id === t1.id)!.d).not.toBeNull();
      expect(rows.find((r) => r.id === t2.id)!.d).not.toBeNull();
      expect(rows.find((r) => r.id === team2.id)!.d).toBeNull();
      const [dept2Row] = await c.admin.select({ d: departments.deletedAt }).from(departments).where(eq(departments.id, dept2.id));
      expect(dept2Row!.d).toBeNull();

      // projects survive; the people who only had a department/team scope lose that access
      expect((await withTenant(c.app, as("admin"), (s) => listProjects(s))).map((p) => p.id)).toContain(proj);
      const [audit] = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "department.delete"), eq(auditLogs.targetId, d.id)));
      expect(audit).toBeTruthy();
      expect(audit!.metadata).toMatchObject({ teams: 2 });

      // a new team cannot be added to a deleted department
      expect(await code(withTenant(c.app, as("admin"), (s) => createTeam(s, { departmentId: d.id, name: "late" })))).toBe("NOT_FOUND");
      expect(await code(delDept(as("admin"), d.id))).toBe("NOT_FOUND");
    });

    it("a member's membership survives when their only (department) role is removed - they just lose access", async () => {
      const d = await withTenant(c.app, as("admin"), (s) => createDepartment(s, { name: "Another one" }));
      const person = await makeUser(c.admin, "lonely");
      await addMember(c.admin, O.org.id, person.id, { role: "member", scope: { type: "department", id: d.id } });
      await delDept(as("admin"), d.id);
      expect(await withTenant(c.app, { userId: person.id, orgId: O.org.id }, (s) => listProjects(s))).toEqual([]);
    });
  });

  describe("a project", () => {
    it("is removed together with its tasks, recurring series and Discord destinations", async () => {
      const proj = (await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Doomed project" }))).id;
      const other = (await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "Bystander project" }))).id;
      const [t1] = await c.admin.insert(tasks).values({ orgId: O.org.id, projectId: proj, title: "Task 1", createdBy: u.admin!.id }).returning({ id: tasks.id });
      const [t2] = await c.admin.insert(tasks).values({ orgId: O.org.id, projectId: proj, title: "Task 2", parentId: t1!.id, createdBy: u.admin!.id }).returning({ id: tasks.id });
      const [bystander] = await c.admin.insert(tasks).values({ orgId: O.org.id, projectId: other, title: "Keep me", createdBy: u.admin!.id }).returning({ id: tasks.id });
      const [series] = await c.admin.insert(recurrenceSeries).values({
        orgId: O.org.id, projectId: proj, title: "Weekly", rule: { frequency: "weekly", interval: 1, weekdays: [1] }, startDate: "2030-01-01", timezone: "UTC", createdBy: u.admin!.id,
      }).returning({ id: recurrenceSeries.id });
      const [dest] = await c.admin.insert(integrationDestinations).values({
        orgId: O.org.id, projectId: proj, name: "Project channel", webhookCiphertext: "ciphertext", webhookHint: "abcd", events: ["task.created"], createdBy: u.admin!.id,
      }).returning({ id: integrationDestinations.id });
      await c.admin.insert(projectTeams).values({ orgId: O.org.id, projectId: proj, teamId: team2.id });
      const projectMember = await makeUser(c.admin, "projmember");
      await addMember(c.admin, O.org.id, projectMember.id, { role: "member", scope: { type: "project", id: proj } });

      const res = await delProject(as("admin"), proj);
      expect(res.tasks).toBe(2);

      expect((await withTenant(c.app, as("admin"), (s) => listProjects(s))).map((p) => p.id)).not.toContain(proj);
      expect(await code(withTenant(c.app, as("admin"), (s) => getProject(s, proj)))).toBe("NOT_FOUND");
      const list = await withTenant(c.app, as("admin"), (s) => listTasks(s, {}));
      expect(list.items.map((t) => t.id)).not.toContain(t1!.id);
      expect(list.items.map((t) => t.id)).not.toContain(t2!.id);
      expect(list.items.map((t) => t.id)).toContain(bystander!.id);

      const gone = await c.admin.select({ id: tasks.id, d: tasks.deletedAt, by: tasks.deletedBy }).from(tasks).where(inArray(tasks.id, [t1!.id, t2!.id]));
      expect(gone.every((r) => r.d !== null && r.by === u.admin!.id)).toBe(true);
      const [keep] = await c.admin.select({ d: tasks.deletedAt }).from(tasks).where(eq(tasks.id, bystander!.id));
      expect(keep!.d).toBeNull();
      const [sr] = await c.admin.select().from(recurrenceSeries).where(eq(recurrenceSeries.id, series!.id));
      expect(sr!.deletedAt).not.toBeNull();
      expect(sr!.active).toBe(false);
      const [ds] = await c.admin.select().from(integrationDestinations).where(eq(integrationDestinations.id, dest!.id));
      expect(ds!.deletedAt).not.toBeNull();
      expect(ds!.webhookCiphertext).toBe("destroyed");
      expect(await c.admin.select().from(projectTeams).where(eq(projectTeams.projectId, proj))).toHaveLength(0);
      expect(await c.admin.select().from(roleAssignments).where(eq(roleAssignments.projectId, proj))).toHaveLength(0);

      // each trashed task is announced like a normal deletion, so calendars drop their entries
      const events = await c.admin.select({ p: outboxEvents.payload }).from(outboxEvents).where(and(eq(outboxEvents.orgId, O.org.id), eq(outboxEvents.type, "task.deleted")));
      const announced = events.map((e) => (e.p as { taskId: string }).taskId);
      expect(announced).toEqual(expect.arrayContaining([t1!.id, t2!.id]));
      expect(announced).not.toContain(bystander!.id);

      const [audit] = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "project.delete"), eq(auditLogs.targetId, proj)));
      expect(audit!.metadata).toMatchObject({ tasks: 2 });

      expect(await code(delProject(as("admin"), proj))).toBe("NOT_FOUND");
    });

    it("a trashed task of a deleted project cannot be brought back to life by the person who deleted it", async () => {
      const proj = (await withTenant(c.app, as("admin"), (s) => createProject(s, { name: "No way back" }))).id;
      const [t] = await c.admin.insert(tasks).values({ orgId: O.org.id, projectId: proj, title: "Gone", createdBy: u.admin!.id }).returning({ id: tasks.id });
      await delProject(as("admin"), proj);
      const { restoreTask } = await import("@/data/tasks");
      expect(await code(withTenant(c.app, as("admin"), (s) => restoreTask(s, t!.id)))).toBe("NOT_FOUND");
    });

    it("keeps its row (soft delete) so references stay valid", async () => {
      const [row] = await c.admin.select({ d: projects.deletedAt }).from(projects).where(and(eq(projects.orgId, O.org.id), eq(projects.name, "Doomed project")));
      expect(row!.d).not.toBeNull();
      expect(await c.admin.select().from(projects).where(and(eq(projects.orgId, O.org.id), isNull(projects.deletedAt)))).not.toHaveLength(0);
    });
  });
});
