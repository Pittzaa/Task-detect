import type { Permission } from "./permissions";

export type ScopeType = "organization" | "department" | "team" | "project";

/** A role assignment already resolved to its permission set. */
export interface ResolvedAssignment {
  scopeType: ScopeType;
  departmentId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
  permissions: ReadonlySet<Permission>;
}

/** Where the target resource sits. Every field the caller knows from the DB (never from the client). */
export interface ResourceScope {
  orgId: string;
  departmentId?: string | null;
  teamId?: string | null;
  projectId?: string | null;
}

export interface Principal {
  userId: string;
  orgId: string;
  membershipStatus: "pending" | "approved" | "suspended" | "revoked";
  assignments: readonly ResolvedAssignment[];
}

function covers(a: ResolvedAssignment, r: ResourceScope): boolean {
  switch (a.scopeType) {
    case "organization":
      return true;
    case "department":
      return !!a.departmentId && a.departmentId === r.departmentId;
    case "team":
      return !!a.teamId && a.teamId === r.teamId;
    case "project":
      return !!a.projectId && a.projectId === r.projectId;
    default:
      return false;
  }
}

/**
 * Deny by default. Effective permissions are the union of every assignment whose scope covers
 * the resource. There are no explicit denies. A principal for another organization, or whose
 * membership is not `approved`, is always denied.
 */
export function can(principal: Principal, permission: Permission, resource: ResourceScope): boolean {
  if (principal.membershipStatus !== "approved") return false;
  if (principal.orgId !== resource.orgId) return false;
  return principal.assignments.some((a) => a.permissions.has(permission) && covers(a, resource));
}
