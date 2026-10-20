import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import type { Permission } from "@/authz/permissions";
import { auditLogs, memberships, organizations, users } from "@/db/schema";
import { appNameOrDefault } from "@/domain/app-name";
import { notFound } from "@/lib/errors";
import { loadPrincipals, type TenantSession } from "./tenant";
import { projectScope } from "./scope";

const UI_FLAGS: Record<string, Permission> = {
  manageSettings: "org.manage_settings",
  manageMembers: "org.manage_members",
  approveMembers: "org.approve_members",
  manageRoles: "org.manage_roles",
  manageIntegrations: "org.manage_integrations",
  manageCustomFields: "org.manage_custom_fields",
  readAuditLog: "org.read_audit_log",
  createProject: "project.create",
  deleteProject: "project.delete",
  manageDepartments: "department.manage",
  manageTeams: "team.manage",
  manageLabels: "label.manage",
  manageSeries: "series.manage",
  shareOrgViews: "view.share_org",
};

/** What the signed-in user may do at organization level. Used only to show or hide controls; the server enforces every action again. */
export async function getContext(s: TenantSession) {
  const [row] = await s.tx.select({ id: organizations.id, name: organizations.name, appName: organizations.appName }).from(organizations).where(eq(organizations.id, s.orgId));
  if (!row) throw notFound();
  const org = { id: row.id, name: row.name, appName: appNameOrDefault(row.appName) };
  const flags = Object.fromEntries(Object.entries(UI_FLAGS).map(([k, p]) => [k, can(s.principal, p, { orgId: s.orgId })]));
  // Scoped roles (a team or project) can create tasks without any organization-wide grant, so this is "anywhere", not "org level".
  const createsSomewhere = s.principal.assignments.some((a) => a.permissions.has("task.create"));
  const readsSomething = s.principal.assignments.some((a) => a.permissions.has("task.read"));
  const managesSeriesSomewhere = s.principal.assignments.some((a) => a.permissions.has("series.manage"));
  const flagsOut: Record<string, boolean> = { ...flags, createTask: createsSomewhere, manageSeries: managesSeriesSomewhere };
  return { org, can: flagsOut, hasAnyAccess: readsSomething };
}

/** Colleagues who can currently read a project; used by assignee and mention pickers. Names only. */
export async function listPeople(s: TenantSession, projectId: string) {
  const scope = await projectScope(s, projectId);
  if (!scope || !can(s.principal, "task.read", scope)) throw notFound();
  const rows = await s.tx
    .select({ id: users.id, name: users.name })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(memberships.orgId, s.orgId), eq(memberships.status, "approved"), isNull(users.deletedAt)))
    .orderBy(asc(users.name))
    .limit(500);
  // one batch for everybody else instead of three queries per member
  const others = await loadPrincipals(s.tx, rows.filter((r) => r.id !== s.userId).map((r) => r.id), s.orgId);
  return rows.filter((r) => {
    const principal = r.id === s.userId ? s.principal : others.get(r.id);
    return !!principal && can(principal, "task.read", scope);
  });
}

export async function listAuditLogs(s: TenantSession, o: { action?: string; limit?: number; offset?: number } = {}) {
  s.require("org.read_audit_log");
  const limit = Math.min(Math.max(o.limit ?? 50, 1), 100);
  const rows = await s.tx
    .select({ id: auditLogs.id, action: auditLogs.action, actorId: auditLogs.actorUserId, actorName: users.name, targetType: auditLogs.targetType, targetId: auditLogs.targetId, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .leftJoin(users, eq(users.id, auditLogs.actorUserId))
    .where(and(eq(auditLogs.orgId, s.orgId), o.action ? sql`${auditLogs.action} like ${o.action.replace(/[\\%_]/g, "\\$&") + "%"}` : undefined))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(limit + 1)
    .offset(Math.max(o.offset ?? 0, 0));
  return { items: rows.slice(0, limit), hasMore: rows.length > limit };
}

