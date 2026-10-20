import { and, eq, inArray, sql } from "drizzle-orm";
import { can, type Principal, type ResolvedAssignment, type ResourceScope } from "@/authz/evaluate";
import { isPermission, type Permission } from "@/authz/permissions";
import { AppError, forbidden, notFound } from "@/lib/errors";
import { describeError } from "@/lib/error-report";
import { logger } from "@/lib/logger";
import type { Db, Tx } from "@/db/client";
import { auditLogs, memberships, rolePermissions, roleAssignments } from "@/db/schema";
import { assertRlsEnforced } from "@/db/rls-guard";
import { consumeRateLimit } from "@/server/rate-limit";

export interface TenantSession {
  tx: Tx;
  orgId: string;
  userId: string;
  principal: Principal;
  /** Throws `forbidden` (and records an audit entry after rollback) unless the principal holds the permission for the resource. */
  require(permission: Permission, resource?: Omit<ResourceScope, "orgId">): void;
  /**
   * For organization-level metadata that is safe for anyone who holds the permission *somewhere*
   * (for example listing labels or custom field definitions).
   */
  requireAny(permission: Permission): void;
}

async function setContext(tx: Tx, userId: string, orgId: string | null) {
  await tx.execute(
    sql`select set_config('app.user_id', ${userId}, true), set_config('app.org_id', ${orgId ?? ""}, true)`,
  );
}

export async function loadPrincipal(tx: Tx, userId: string, orgId: string): Promise<Principal | null> {
  return (await loadPrincipals(tx, [userId], orgId)).get(userId) ?? null;
}

/**
 * Principals of many users of one organization in three queries (memberships, assignments, role permissions) instead of three per user.
 * Users without a membership are absent from the result.
 */
export async function loadPrincipals(tx: Tx, userIds: string[], orgId: string): Promise<Map<string, Principal>> {
  const out = new Map<string, Principal>();
  const ids = [...new Set(userIds)];
  if (!ids.length) return out;
  const ms = await tx
    .select({ id: memberships.id, userId: memberships.userId, status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.orgId, orgId), inArray(memberships.userId, ids)));
  if (!ms.length) return out;

  const rows = await tx
    .select({
      id: roleAssignments.id,
      membershipId: roleAssignments.membershipId,
      scopeType: roleAssignments.scopeType,
      departmentId: roleAssignments.departmentId,
      teamId: roleAssignments.teamId,
      projectId: roleAssignments.projectId,
      roleId: roleAssignments.roleId,
    })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.orgId, orgId), inArray(roleAssignments.membershipId, ms.map((m) => m.id))));

  const roleIds = [...new Set(rows.map((r) => r.roleId))];
  const perms = roleIds.length
    ? await tx.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds))
    : [];
  const byRole = new Map<string, Set<Permission>>();
  for (const p of perms) {
    if (!isPermission(p.permission)) continue; // unknown/removed permission strings grant nothing
    (byRole.get(p.roleId) ?? byRole.set(p.roleId, new Set()).get(p.roleId)!).add(p.permission);
  }

  for (const m of ms) {
    const assignments: ResolvedAssignment[] = rows
      .filter((r) => r.membershipId === m.id)
      .map((r) => ({
        scopeType: r.scopeType,
        departmentId: r.departmentId,
        teamId: r.teamId,
        projectId: r.projectId,
        permissions: byRole.get(r.roleId) ?? new Set<Permission>(),
      }));
    out.set(m.userId, { userId: m.userId, orgId, membershipStatus: m.status, assignments });
  }
  return out;
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
  // one spelling of an id everywhere: the database reads upper and lower case alike, but our counters and comparisons are plain strings
  const orgId = auth.orgId.toLowerCase();
  await assertRlsEnforced(db);
  let denied: { permission: string } | undefined;
  try {
    return await db.transaction(async (tx) => {
      await setContext(tx, auth.userId, null);
      const probe = await loadMembershipStatus(tx, auth.userId, orgId);
      if (probe !== "approved") throw notFound();

      await setContext(tx, auth.userId, orgId);
      const principal = await loadPrincipal(tx, auth.userId, orgId);
      if (!principal || principal.membershipStatus !== "approved") throw notFound();

      return fn({
        tx,
        orgId,
        userId: auth.userId,
        principal,
        require(permission, resource = {}) {
          if (!can(principal, permission, { orgId, ...resource })) {
            throw forbidden({ permission });
          }
        },
        requireAny(permission) {
          if (!principal.assignments.some((a) => a.permissions.has(permission))) throw forbidden({ permission });
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

/** At most this many denials per person per organization are written to the audit log in a window: a member who keeps asking for what they may not do cannot fill it with noise (audit rows cannot be purged for 90 days). */
const DENIAL_AUDIT_LIMIT = { windowSeconds: 600, max: 30 };

async function recordDenial(db: Db, auth: { userId: string; orgId: string }, permission: string) {
  try {
    try {
      await consumeRateLimit(db, `denied:${auth.userId}:${auth.orgId}`, DENIAL_AUDIT_LIMIT.windowSeconds, DENIAL_AUDIT_LIMIT.max);
    } catch (e) {
      if (e instanceof AppError && e.code === "RATE_LIMITED") return;
      throw e;
    }
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
    logger.error({ error: describeError(e) }, "failed to record authorization denial");
  }
}
