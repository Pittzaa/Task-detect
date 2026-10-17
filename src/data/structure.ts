import { and, eq, isNull } from "drizzle-orm";
import { notFound } from "@/lib/errors";
import { auditLogs, departments, projects, teams } from "@/db/schema";
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

export async function listProjects(s: TenantSession) {
  s.require("project.read");
  return s.tx
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.orgId, s.orgId), isNull(projects.deletedAt)))
    .limit(200);
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
  s.require("project.read", { projectId });
  const [row] = await s.tx
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(and(eq(projects.orgId, s.orgId), eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!row) throw notFound();
  return row;
}
