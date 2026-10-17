import { and, eq, inArray, sql } from "drizzle-orm";
import { can, type Principal, type ResolvedAssignment, type ResourceScope } from "@/authz/evaluate";
import { isPermission, type Permission } from "@/authz/permissions";
import { AppError, forbidden, notFound } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Db, Tx } from "@/db/client";
import { auditLogs, memberships, rolePermissions, roleAssignments } from "@/db/schema";

export interface TenantSession {
  tx: Tx;
  orgId: string;
  userId: string;
  principal: Principal;
  /** Throws `forbidden` (and records an audit entry after rollback) unless the principal holds the permission for the resource. */
  require(permission: Permission, resource?: Omit<ResourceScope, "orgId">): void;
}

async function setContext(tx: Tx, userId: string, orgId: string | null) {
  await tx.execute(
    sql`select set_config('app.user_id', ${userId}, true), set_config('app.org_id', ${orgId ?? ""}, true)`,
  );
}

async function loadPrincipal(tx: Tx, userId: string, orgId: string): Promise<Principal | null> {
  const [m] = await tx
    .select({ id: memberships.id, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  if (!m) return null;

  const rows = await tx
    .select({
      id: roleAssignments.id,
      scopeType: roleAssignments.scopeType,
      departmentId: roleAssignments.departmentId,
      teamId: roleAssignments.teamId,
      projectId: roleAssignments.projectId,
      roleId: roleAssignments.roleId,
    })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.orgId, orgId), eq(roleAssignments.membershipId, m.id)));

  const roleIds = [...new Set(rows.map((r) => r.roleId))];
  const perms = roleIds.length
    ? await tx.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds))
    : [];
  const byRole = new Map<string, Set<Permission>>();
  for (const p of perms) {
    if (!isPermission(p.permission)) continue; // unknown/removed permission strings grant nothing
    (byRole.get(p.roleId) ?? byRole.set(p.roleId, new Set()).get(p.roleId)!).add(p.permission);
  }

  const assignments: ResolvedAssignment[] = rows.map((r) => ({
    scopeType: r.scopeType,
    departmentId: r.departmentId,
    teamId: r.teamId,
    projectId: r.projectId,
    permissions: byRole.get(r.roleId) ?? new Set<Permission>(),
  }));
  return { userId, orgId, membershipStatus: m.status, assignments };
}

/**
 * The single entry point for tenant-scoped work. In one transaction it:
 *  1. sets the DB context (RLS) to the *authenticated* user,
 *  2. finds the user's membership in the requested org (the org id from the client is only a
 *     request, never proof of access) and refuses non-approved memberships,
 *  3. sets the org context and loads the principal's role assignments,
 *  4. runs `fn`.
 * A missing or non-approved membership yields `notFound` so org existence is not disclosed.
 */
export async function withTenant<T>(
  db: Db,
  auth: { userId: string; orgId: string },
  fn: (s: TenantSession) => Promise<T>,
): Promise<T> {
  let denied: { permission: string } | undefined;
  try {
    return await db.transaction(async (tx) => {
      await setContext(tx, auth.userId, null);
      const probe = await loadMembershipStatus(tx, auth.userId, auth.orgId);
      if (probe !== "approved") throw notFound();

      await setContext(tx, auth.userId, auth.orgId);
      const principal = await loadPrincipal(tx, auth.userId, auth.orgId);
      if (!principal || principal.membershipStatus !== "approved") throw notFound();

      return fn({
        tx,
        orgId: auth.orgId,
        userId: auth.userId,
        principal,
        require(permission, resource = {}) {
          if (!can(principal, permission, { orgId: auth.orgId, ...resource })) {
            throw forbidden({ permission });
          }
        },
      });
    });
  } catch (err) {
    if (err instanceof AppError && err.code === "FORBIDDEN" && err.detail?.permission) {
      denied = { permission: err.detail.permission };
    } else {
      throw err;
    }
  }
  // The original transaction rolled back, so the denial is recorded in a fresh one (best effort).
  await recordDenial(db, auth, denied.permission);
  throw forbidden();
}

async function loadMembershipStatus(tx: Tx, userId: string, orgId: string) {
  const [m] = await tx
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
  return m?.status;
}

async function recordDenial(db: Db, auth: { userId: string; orgId: string }, permission: string) {
  try {
    await db.transaction(async (tx) => {
      await setContext(tx, auth.userId, auth.orgId);
      await tx.insert(auditLogs).values({
        orgId: auth.orgId,
        actorUserId: auth.userId,
        action: "authz.denied",
        metadata: { permission },
      });
    });
  } catch (e) {
    logger.error({ err: e instanceof Error ? e.message : "unknown" }, "failed to record authorization denial");
  }
}
