import { and, eq, inArray, isNull } from "drizzle-orm";
import { can, type ResourceScope } from "@/authz/evaluate";
import type { Permission } from "@/authz/permissions";
import { projectTeams, projects, teams } from "@/db/schema";
import type { TenantSession } from "./tenant";

/**
 * Authorization scope of a project: itself plus every team and department participating in it.
 * Team/department-scoped role assignments cover the project (and so its tasks) through these ids.
 * Returns null when the project does not exist in this organization (or is deleted).
 */
export async function projectScope(s: TenantSession, projectId: string): Promise<ResourceScope | null> {
  const [p] = await s.tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, s.orgId), eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!p) return null;
  const rows = await s.tx
    .select({ teamId: teams.id, departmentId: teams.departmentId })
    .from(projectTeams)
    .innerJoin(teams, and(eq(teams.orgId, projectTeams.orgId), eq(teams.id, projectTeams.teamId)))
    .where(and(eq(projectTeams.orgId, s.orgId), eq(projectTeams.projectId, projectId), isNull(teams.deletedAt)));
  return {
    orgId: s.orgId,
    projectId,
    teamIds: rows.map((r) => r.teamId),
    departmentIds: [...new Set(rows.map((r) => r.departmentId))],
  };
}

/** Scopes for many projects at once (2 queries). */
export async function projectScopes(s: TenantSession, projectIds: string[]): Promise<Map<string, ResourceScope>> {
  const out = new Map<string, ResourceScope>();
  if (!projectIds.length) return out;
  for (const id of projectIds) out.set(id, { orgId: s.orgId, projectId: id, teamIds: [], departmentIds: [] });
  const rows = await s.tx
    .select({ projectId: projectTeams.projectId, teamId: teams.id, departmentId: teams.departmentId })
    .from(projectTeams)
    .innerJoin(teams, and(eq(teams.orgId, projectTeams.orgId), eq(teams.id, projectTeams.teamId)))
    .where(and(eq(projectTeams.orgId, s.orgId), inArray(projectTeams.projectId, projectIds), isNull(teams.deletedAt)));
  for (const r of rows) {
    const sc = out.get(r.projectId)!;
    (sc.teamIds as string[]).push(r.teamId);
    if (!(sc.departmentIds as string[]).includes(r.departmentId)) (sc.departmentIds as string[]).push(r.departmentId);
  }
  return out;
}

/**
 * Which projects may this principal use with `permission`? `"all"` when granted at organization scope,
 * otherwise the explicit list (possibly empty). Used to scope list/search/calendar queries in SQL.
 */
export async function accessibleProjectIds(s: TenantSession, permission: Permission): Promise<"all" | string[]> {
  if (can(s.principal, permission, { orgId: s.orgId })) return "all";
  if (!s.principal.assignments.some((a) => a.permissions.has(permission))) return [];
  const all = await s.tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, s.orgId), isNull(projects.deletedAt)))
    .limit(2000);
  const scopes = await projectScopes(s, all.map((p) => p.id));
  return all.filter((p) => can(s.principal, permission, scopes.get(p.id)!)).map((p) => p.id);
}
