import { and, eq, inArray, isNull } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import { confirmMatches } from "@/lib/confirm";
import { notFound, validation } from "@/lib/errors";
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
    .where(and(eq(departments.orgId, s.orgId), eq(departments.id, input.departmentId), isNull(departments.deletedAt)))
    .for("share"); // see projectScope: a department being deleted right now must not gain a team
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
  const scope = await projectScope(s, projectId, { lock: true });
  if (!scope || !can(s.principal, "project.read", scope)) throw notFound();
  s.require("project.update", scope);
  const ids = [...new Set(teamIds)];
  if (ids.length > 50) throw notFound();
  if (ids.length) {
    const found = await s.tx.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, s.orgId), inArray(teams.id, ids), isNull(teams.deletedAt))).for("share");
    if (found.length !== ids.length) throw notFound();
  }
  await s.tx.delete(projectTeams).where(and(eq(projectTeams.orgId, s.orgId), eq(projectTeams.projectId, projectId)));
  if (ids.length) await s.tx.insert(projectTeams).values(ids.map((teamId) => ({ orgId: s.orgId, projectId, teamId })));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "project.set_teams", targetType: "project", targetId: projectId, metadata: { teams: ids.length } });
}

// ---------------------------------------------------------------------------------------------
// deleting structure
// ---------------------------------------------------------------------------------------------

type RemovedAssignment = { id: string; membershipId: string; roleId: string; scopeType: string; departmentId: string | null; teamId: string | null; projectId: string | null };

/** One `role.unassign` audit row per access that a deletion took away, so "why did I lose access?" can be answered later. */
async function auditRemovedAssignments(s: TenantSession, removed: RemovedAssignment[], via: string) {
  for (let i = 0; i < removed.length; i += 500) {
    await s.tx.insert(auditLogs).values(removed.slice(i, i + 500).map((a) => ({
      orgId: s.orgId, actorUserId: s.userId, action: "role.unassign", targetType: "role_assignment", targetId: a.id,
      metadata: { via, membershipId: a.membershipId, roleId: a.roleId, scope: a.scopeType, scopeId: a.departmentId ?? a.teamId ?? a.projectId },
    })));
  }
}

const ASSIGNMENT_COLUMNS = {
  id: roleAssignments.id, membershipId: roleAssignments.membershipId, roleId: roleAssignments.roleId, scopeType: roleAssignments.scopeType,
  departmentId: roleAssignments.departmentId, teamId: roleAssignments.teamId, projectId: roleAssignments.projectId,
};

/**
 * Everything that points at the given teams stops pointing at them: role assignments are removed (the people keep their
 * membership and any other role), team-shared views are trashed, Discord destinations are destroyed, and the teams leave
 * their projects. The team rows themselves are soft-deleted so history that mentions them stays readable.
 * Returns what was taken away, for the audit entry.
 */
async function retireTeams(s: TenantSession, teamIds: string[], now: Date, via: string) {
  if (!teamIds.length) return { assignments: 0, projectLinks: 0, views: 0, destinations: 0 };
  const assignments = await s.tx.delete(roleAssignments).where(and(eq(roleAssignments.orgId, s.orgId), inArray(roleAssignments.teamId, teamIds))).returning(ASSIGNMENT_COLUMNS);
  await auditRemovedAssignments(s, assignments, via);
  const links = await s.tx.delete(projectTeams).where(and(eq(projectTeams.orgId, s.orgId), inArray(projectTeams.teamId, teamIds))).returning({ p: projectTeams.projectId });
  const views = await s.tx.update(savedViews).set({ deletedAt: now, updatedAt: now }).where(and(eq(savedViews.orgId, s.orgId), inArray(savedViews.teamId, teamIds), isNull(savedViews.deletedAt))).returning({ id: savedViews.id });
  const destinations = await s.tx
    .update(integrationDestinations)
    .set({ deletedAt: now, enabled: false, webhookCiphertext: DESTROYED_SECRET })
    .where(and(eq(integrationDestinations.orgId, s.orgId), inArray(integrationDestinations.teamId, teamIds), isNull(integrationDestinations.deletedAt)))
    .returning({ id: integrationDestinations.id });
  await s.tx.update(teams).set({ deletedAt: now }).where(and(eq(teams.orgId, s.orgId), inArray(teams.id, teamIds)));
  return { assignments: assignments.length, projectLinks: links.length, views: views.length, destinations: destinations.length };
}

/** What a delete request must carry: the exact name of the thing being deleted, typed by the person. Checked after the permission. */
function requireTypedName(typed: string, name: string) {
  if (!confirmMatches(typed, name)) throw validation("val.confirm_mismatch");
}

const add = (a: { assignments: number; projectLinks: number; views: number; destinations: number }, b: typeof a) => ({
  assignments: a.assignments + b.assignments, projectLinks: a.projectLinks + b.projectLinks, views: a.views + b.views, destinations: a.destinations + b.destinations,
});

/** Deletes a department together with its teams. Needs `department.manage` for the whole organization and the department's name, typed. */
export async function deleteDepartment(s: TenantSession, departmentId: string, confirm: string) {
  const [seen] = await s.tx.select({ id: departments.id }).from(departments).where(and(eq(departments.orgId, s.orgId), eq(departments.id, departmentId), isNull(departments.deletedAt)));
  if (!seen) throw notFound();
  s.require("department.manage");
  // locked only once the person is known to be allowed to delete it
  const [dept] = await s.tx
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .where(and(eq(departments.orgId, s.orgId), eq(departments.id, departmentId), isNull(departments.deletedAt)))
    .for("update");
  if (!dept) throw notFound();
  requireTypedName(confirm, dept.name);
  const now = new Date();
  const own = await s.tx
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.orgId, s.orgId), eq(teams.departmentId, dept.id), isNull(teams.deletedAt)))
    .for("update");
  const gone = await retireTeams(s, own.map((t) => t.id), now, "department.delete");
  const ownAssignments = await s.tx.delete(roleAssignments).where(and(eq(roleAssignments.orgId, s.orgId), eq(roleAssignments.departmentId, dept.id))).returning(ASSIGNMENT_COLUMNS);
  await auditRemovedAssignments(s, ownAssignments, "department.delete");
  await s.tx.update(departments).set({ deletedAt: now }).where(and(eq(departments.orgId, s.orgId), eq(departments.id, dept.id)));
  const total = add(gone, { assignments: ownAssignments.length, projectLinks: 0, views: 0, destinations: 0 });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "department.delete", targetType: "department", targetId: dept.id, metadata: { teams: own.length, ...total } });
  return { teams: own.length };
}

/** Deletes one team. Needs `team.manage` for its department (an organization-wide grant covers every department); a team's own administrators cannot delete their team. The team's name must be typed. */
export async function deleteTeam(s: TenantSession, teamId: string, confirm: string) {
  const [seen] = await s.tx.select({ id: teams.id, departmentId: teams.departmentId }).from(teams).where(and(eq(teams.orgId, s.orgId), eq(teams.id, teamId), isNull(teams.deletedAt)));
  if (!seen) throw notFound();
  s.require("team.manage", { departmentId: seen.departmentId });
  const [team] = await s.tx
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(and(eq(teams.orgId, s.orgId), eq(teams.id, teamId), isNull(teams.deletedAt)))
    .for("update");
  if (!team) throw notFound();
  requireTypedName(confirm, team.name);
  const gone = await retireTeams(s, [team.id], new Date(), "team.delete");
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "team.delete", targetType: "team", targetId: team.id, metadata: gone });
}

/**
 * Deletes a project with everything inside it: its tasks go to the trash (the retention job purges them later; they cannot
 * be restored because their project is gone), its recurring series stop, and its Discord destinations are destroyed. The project's name must be typed.
 */
export async function deleteProject(s: TenantSession, projectId: string, confirm: string) {
  const scope = await projectScope(s, projectId);
  if (!scope || !can(s.principal, "project.read", scope)) throw notFound();
  s.require("project.delete", scope);
  const [project] = await s.tx.select({ id: projects.id, name: projects.name }).from(projects).where(and(eq(projects.orgId, s.orgId), eq(projects.id, projectId), isNull(projects.deletedAt))).for("update");
  if (!project) throw notFound();
  requireTypedName(confirm, project.name);
  const now = new Date();
  const removed = await s.tx
    .update(tasks)
    .set({ deletedAt: now, deletedBy: s.userId, updatedAt: now })
    .where(and(eq(tasks.orgId, s.orgId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt)))
    .returning({ id: tasks.id });
  // the same event deleting a task one by one would raise, so calendars drop their entries for these tasks
  for (let i = 0; i < removed.length; i += 500) {
    await s.tx.insert(outboxEvents).values(removed.slice(i, i + 500).map((t) => ({ orgId: s.orgId, type: "task.deleted", payload: { taskId: t.id, actorId: s.userId } })));
  }
  const series = await s.tx.update(recurrenceSeries).set({ active: false, deletedAt: now, updatedAt: now }).where(and(eq(recurrenceSeries.orgId, s.orgId), eq(recurrenceSeries.projectId, projectId), isNull(recurrenceSeries.deletedAt))).returning({ id: recurrenceSeries.id });
  const destinations = await s.tx
    .update(integrationDestinations)
    .set({ deletedAt: now, enabled: false, webhookCiphertext: DESTROYED_SECRET })
    .where(and(eq(integrationDestinations.orgId, s.orgId), eq(integrationDestinations.projectId, projectId), isNull(integrationDestinations.deletedAt)))
    .returning({ id: integrationDestinations.id });
  const links = await s.tx.delete(projectTeams).where(and(eq(projectTeams.orgId, s.orgId), eq(projectTeams.projectId, projectId))).returning({ t: projectTeams.teamId });
  const assignments = await s.tx.delete(roleAssignments).where(and(eq(roleAssignments.orgId, s.orgId), eq(roleAssignments.projectId, projectId))).returning(ASSIGNMENT_COLUMNS);
  await auditRemovedAssignments(s, assignments, "project.delete");
  await s.tx.update(projects).set({ deletedAt: now }).where(and(eq(projects.orgId, s.orgId), eq(projects.id, projectId)));
  await s.tx.insert(auditLogs).values({
    orgId: s.orgId, actorUserId: s.userId, action: "project.delete", targetType: "project", targetId: projectId,
    metadata: { tasks: removed.length, series: series.length, destinations: destinations.length, teamLinks: links.length, assignments: assignments.length },
  });
  return { tasks: removed.length };
}
