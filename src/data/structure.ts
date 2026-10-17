import { and, eq, inArray, isNull } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import { notFound } from "@/lib/errors";
import { auditLogs, departments, projectTeams, projects, teams } from "@/db/schema";
import { accessibleProjectIds, projectScope } from "./scope";
import type { TenantSession } from "./tenant";

/**
 * Every query filters on `orgId` explicitly even though RLS enforces it too, so a missing or
 * misconfigured policy cannot by itself cause cross-tenant exposure.
 */

export async function listDepartments(s: TenantSession) {
  s.require("department.read");
  return s.tx
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .where(and(eq(departments.orgId, s.orgId), isNull(departments.deletedAt)))
    .limit(200);
}

export async function createDepartment(s: TenantSession, input: { name: string }) {
  s.require("department.manage");
  const [row] = await s.tx
    .insert(departments)
    .values({ orgId: s.orgId, name: input.name })
    .returning({ id: departments.id, name: departments.name });
  await s.tx.insert(auditLogs).values({
    orgId: s.orgId,
    actorUserId: s.userId,
    action: "department.create",
    targetType: "department",
    targetId: row!.id,
  });
  return row!;
}

export async function createTeam(s: TenantSession, input: { departmentId: string; name: string }) {
  s.require("team.manage", { departmentId: input.departmentId });
  // The client-supplied department id is only trusted once it is found inside this org.
  const [dept] = await s.tx
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.orgId, s.orgId), eq(departments.id, input.departmentId), isNull(departments.deletedAt)));
  if (!dept) throw notFound();
  const [row] = await s.tx
    .insert(teams)
    .values({ orgId: s.orgId, departmentId: dept.id, name: input.name })
    .returning({ id: teams.id, name: teams.name });
  await s.tx.insert(auditLogs).values({
    orgId: s.orgId,
    actorUserId: s.userId,
    action: "team.create",
    targetType: "team",
    targetId: row!.id,
  });
  return row!;
}

/** Lists the projects the principal may read: all of them with an organization-wide grant, otherwise only covered ones. */
export async function listProjects(s: TenantSession) {
  const ids = await accessibleProjectIds(s, "project.read");
  if (Array.isArray(ids) && ids.length === 0) return [];
  const where = and(eq(projects.orgId, s.orgId), isNull(projects.deletedAt), ...(ids === "all" ? [] : [inArray(projects.id, ids)]));
  return s.tx.select({ id: projects.id, name: projects.name }).from(projects).where(where).limit(200);
}

export async function createProject(s: TenantSession, input: { name: string }) {
  s.require("project.create");
  const [row] = await s.tx
    .insert(projects)
    .values({ orgId: s.orgId, name: input.name })
    .returning({ id: projects.id, name: projects.name });
  await s.tx.insert(auditLogs).values({
    orgId: s.orgId,
    actorUserId: s.userId,
    action: "project.create",
    targetType: "project",
    targetId: row!.id,
  });
  return row!;
}

export async function getProject(s: TenantSession, projectId: string) {
  const scope = await projectScope(s, projectId);
  // Missing and unreadable are indistinguishable on purpose.
  if (!scope || !can(s.principal, "project.read", scope)) throw notFound();
  const [row] = await s.tx
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.orgId, s.orgId), eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!row) throw notFound();
  return { ...row, teamIds: [...(scope.teamIds ?? [])] };
}

export async function listTeams(s: TenantSession) {
  s.require("team.read");
  return s.tx
    .select({ id: teams.id, name: teams.name, departmentId: teams.departmentId })
    .from(teams)
    .where(and(eq(teams.orgId, s.orgId), isNull(teams.deletedAt)))
    .limit(500);
}

/** Replaces the set of teams participating in a project. Participating teams gain scope over its tasks. */
export async function setProjectTeams(s: TenantSession, projectId: string, teamIds: string[]) {
  const scope = await projectScope(s, projectId);
  if (!scope || !can(s.principal, "project.read", scope)) throw notFound();
  s.require("project.update", scope);
  const ids = [...new Set(teamIds)];
  if (ids.length > 50) throw notFound();
  if (ids.length) {
    const found = await s.tx.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, s.orgId), inArray(teams.id, ids), isNull(teams.deletedAt)));
    if (found.length !== ids.length) throw notFound();
  }
  await s.tx.delete(projectTeams).where(and(eq(projectTeams.orgId, s.orgId), eq(projectTeams.projectId, projectId)));
  if (ids.length) await s.tx.insert(projectTeams).values(ids.map((teamId) => ({ orgId: s.orgId, projectId, teamId })));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "project.set_teams", targetType: "project", targetId: projectId, metadata: { teams: ids.length } });
}
