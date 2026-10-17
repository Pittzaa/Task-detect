import { and, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import { departments, projects, tasks, teams } from "@/db/schema";
import { validation } from "@/lib/errors";
import { escapeLikeValue } from "./like";
import { accessibleProjectIds } from "./scope";
import type { TenantSession } from "./tenant";

const SNIPPET = 80;

function snippet(text: string, q: string): string | null {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return null;
  const from = Math.max(0, i - SNIPPET / 2);
  return (from > 0 ? "…" : "") + text.slice(from, from + SNIPPET).replace(/\s+/g, " ") + (from + SNIPPET < text.length ? "…" : "");
}

/**
 * Organization-wide search that returns only what the caller may already read. There are no totals,
 * facets or "N more" hints, so nothing can be inferred about records the caller cannot see.
 */
export async function searchAll(s: TenantSession, rawQuery: string, opts: { limit?: number } = {}) {
  const q = rawQuery.trim();
  if (q.length < 2 || q.length > 100) throw validation("Search needs 2-100 characters");
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 20);
  const pattern = `%${escapeLikeValue(q)}%`;

  const accessible = await accessibleProjectIds(s, "task.read");
  const taskRows =
    Array.isArray(accessible) && accessible.length === 0
      ? []
      : await s.tx
          .select({ id: tasks.id, title: tasks.title, description: tasks.description, projectId: tasks.projectId, status: tasks.status })
          .from(tasks)
          .where(and(eq(tasks.orgId, s.orgId), isNull(tasks.deletedAt), or(ilike(tasks.title, pattern), ilike(tasks.description, pattern)), accessible === "all" ? undefined : inArray(tasks.projectId, accessible)))
          .limit(limit);

  const projAccess = await accessibleProjectIds(s, "project.read");
  const projectRows =
    Array.isArray(projAccess) && projAccess.length === 0
      ? []
      : await s.tx
          .select({ id: projects.id, name: projects.name })
          .from(projects)
          .where(and(eq(projects.orgId, s.orgId), isNull(projects.deletedAt), ilike(projects.name, pattern), projAccess === "all" ? undefined : inArray(projects.id, projAccess)))
          .limit(limit);

  const teamCandidates = await s.tx
    .select({ id: teams.id, name: teams.name, departmentId: teams.departmentId })
    .from(teams)
    .where(and(eq(teams.orgId, s.orgId), isNull(teams.deletedAt), ilike(teams.name, pattern)))
    .limit(100);
  const deptCandidates = await s.tx
    .select({ id: departments.id, name: departments.name })
    .from(departments)
    .where(and(eq(departments.orgId, s.orgId), isNull(departments.deletedAt), ilike(departments.name, pattern)))
    .limit(100);

  return {
    tasks: taskRows.map((t) => ({ id: t.id, title: t.title, projectId: t.projectId, status: t.status, snippet: t.title.toLowerCase().includes(q.toLowerCase()) ? null : snippet(t.description, q) })),
    projects: projectRows,
    teams: teamCandidates.filter((t) => can(s.principal, "team.read", { orgId: s.orgId, teamId: t.id, departmentId: t.departmentId })).slice(0, limit).map((t) => ({ id: t.id, name: t.name })),
    departments: deptCandidates.filter((d) => can(s.principal, "department.read", { orgId: s.orgId, departmentId: d.id })).slice(0, limit),
  };
}
