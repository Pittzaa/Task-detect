import { and, eq, inArray, isNull } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import { notFound } from "@/lib/errors";
import { auditLogs, departments, integrationDestinations, outboxEvents, projectTeams, projects, recurrenceSeries, roleAssignments, savedViews, tasks, teams } from "@/db/schema";
import { DESTROYED_SECRET } from "./integrations";
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

// ---------------------------------------------------------------------------------------------
// deleting structure
// ---------------------------------------------------------------------------------------------

/**
 * Everything that points at the given teams stops pointing at them: role assignments are removed (the people keep their
 * membership and any other role), team-shared views are trashed, Discord destinations are destroyed, and the teams leave
 * their projects. The team rows themselves are soft-deleted so history that mentions them stays readable.
 */
async function retireTeams(s: TenantSession, teamIds: string[], now: Date) {
  if (!teamIds.length) return;
  await s.tx.delete(roleAssignments).where(and(eq(roleAssignments.orgId, s.orgId), inArray(roleAssignments.teamId, teamIds)));
  await s.tx.delete(projectTeams).where(and(eq(projectTeams.orgId, s.orgId), inArray(projectTeams.teamId, teamIds)));
  await s.tx.update(savedViews).set({ deletedAt: now, updatedAt: now }).where(and(eq(savedViews.orgId, s.orgId), inArray(savedViews.teamId, teamIds), isNull(savedViews.deletedAt)));
  await s.tx
    .update(integrationDestinations)
    .set({ deletedAt: now, enabled: false, webhookCiphertext: DESTROYED_SECRET })
    .where(and(eq(integrationDestinations.orgId, s.orgId), inArray(integrationDestinations.teamId, teamIds), isNull(integrationDestinations.deletedAt)));
  await s.tx.update(teams).set({ deletedAt: now }).where(and(eq(teams.orgId, s.orgId), inArray(teams.id, teamIds)));
}

/** Deletes a department together with its teams. Needs `department.manage` for the whole organization. */
export async function deleteDepartment(s: TenantSession, departmentId: string) {
  const [dept] = await s.tx
    .select({ id: departments.id })
    .from(departments)
    .where(and(eq(departments.orgId, s.orgId), eq(departments.id, departmentId), isNull(departments.deletedAt)))
    .for("update");
  if (!dept) throw notFound();
  s.require("department.manage");
  const now = new Date();
  const own = await s.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.orgId, s.orgId), eq(teams.departmentId, dept.id), isNull(teams.deletedAt)))
    .for("update");
  await retireTeams(s, own.map((t) => t.id), now);
  await s.tx.delete(roleAssignments).where(and(eq(roleAssignments.orgId, s.orgId), eq(roleAssignments.departmentId, dept.id)));
  await s.tx.update(departments).set({ deletedAt: now }).where(and(eq(departments.orgId, s.orgId), eq(departments.id, dept.id)));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "department.delete", targetType: "department", targetId: dept.id, metadata: { teams: own.length } });
  return { teams: own.length };
}

/** Deletes one team. Needs `team.manage` for its department (an organization-wide grant covers every department); a team's own administrators cannot delete their team. */
export async function deleteTeam(s: TenantSession, teamId: string) {
  const [team] = await s.tx
    .select({ id: teams.id, departmentId: teams.departmentId })
    .from(teams)
    .where(and(eq(teams.orgId, s.orgId), eq(teams.id, teamId), isNull(teams.deletedAt)))
    .for("update");
  if (!team) throw notFound();
  s.require("team.manage", { departmentId: team.departmentId });
  await retireTeams(s, [team.id], new Date());
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "team.delete", targetType: "team", targetId: team.id });
}

/**
 * Deletes a project with everything inside it: its tasks go to the trash (the retention job purges them later; they cannot
 * be restored because their project is gone), its recurring series stop, and its Discord destinations are destroyed.
 */
export async function deleteProject(s: TenantSession, projectId: string) {
  const scope = await projectScope(s, projectId);
  if (!scope || !can(s.principal, "project.read", scope)) throw notFound();
  s.require("project.delete", scope);
  const now = new Date();
  await s.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, s.orgId), eq(projects.id, projectId))).for("update");
  const removed = await s.tx
    .update(tasks)
    .set({ deletedAt: now, deletedBy: s.userId, updatedAt: now })
    .where(and(eq(tasks.orgId, s.orgId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
    .returning({ id: tasks.id });
  // the same event deleting a task one by one would raise, so calendars drop their entries for these tasks
  for (let i = 0; i < removed.length; i += 500) {
    await s.tx.insert(outboxEvents).values(removed.slice(i, i + 500).map((t) => ({ orgId: s.orgId, type: "task.deleted", payload: { taskId: t.id, actorId: s.userId } })));
  }
  await s.tx.update(recurrenceSeries).set({ active: false, deletedAt: now, updatedAt: now }).where(and(eq(recurrenceSeries.orgId, s.orgId), eq(recurrenceSeries.projectId, projectId), isNull(recurrenceSeries.deletedAt)));
  await s.tx
    .update(integrationDestinations)
    .set({ deletedAt: now, enabled: false, webhookCiphertext: DESTROYED_SECRET })
    .where(and(eq(integrationDestinations.orgId, s.orgId), eq(integrationDestinations.projectId, projectId), isNull(integrationDestinations.deletedAt)));
  await s.tx.delete(projectTeams).where(and(eq(projectTeams.orgId, s.orgId), eq(projectTeams.projectId, projectId)));
  await s.tx.delete(roleAssignments).where(and(eq(roleAssignments.orgId, s.orgId), eq(roleAssignments.projectId, projectId)));
  await s.tx.update(projects).set({ deletedAt: now }).where(and(eq(projects.orgId, s.orgId), eq(projects.id, projectId)));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "project.delete", targetType: "project", targetId: projectId, metadata: { tasks: removed.length } });
  return { tasks: removed.length };
}
