import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { can, type ResourceScope } from "@/authz/evaluate";
import { isPermission, type Permission } from "@/authz/permissions";
import type { Db, Tx } from "@/db/client";
import {
  auditLogs, departments, invitations, memberships, organizations, projects, rolePermissions, roleAssignments, roles, teams, users,
} from "@/db/schema";
import { conflict, forbidden, notFound, validation } from "@/lib/errors";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { consumeRateLimit } from "@/server/rate-limit";
import type { TenantSession } from "./tenant";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function setCtx(tx: Tx, ctx: { userId: string; orgId?: string | null; orgSlug?: string; inviteTokenHash?: string }) {
  await tx.execute(sql`select
    set_config('app.user_id', ${ctx.userId}, true),
    set_config('app.org_id', ${ctx.orgId ?? ""}, true),
    set_config('app.org_slug', ${ctx.orgSlug ?? ""}, true),
    set_config('app.invite_token_hash', ${ctx.inviteTokenHash ?? ""}, true)`);
}

/** Records an authentication event in the audit log of every organization the user belongs to. */
export async function auditAuthEvent(db: Db, userId: string, action: string, metadata: Record<string, unknown> = {}) {
  await db.transaction(async (tx) => {
    await setCtx(tx, { userId });
    const mine = await tx.select({ orgId: memberships.orgId }).from(memberships).where(eq(memberships.userId, userId));
    for (const m of mine) {
      await setCtx(tx, { userId, orgId: m.orgId });
      await tx.insert(auditLogs).values({ orgId: m.orgId, actorUserId: userId, action, targetType: "user", targetId: userId, metadata });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Self-service: requesting access and listing one's own memberships
// ---------------------------------------------------------------------------------------------

/**
 * Creates a PENDING membership for the signed-in user in the organization with this code.
 * The response never reveals whether the code exists, so organization codes cannot be enumerated.
 */
export async function requestAccess(db: Db, userId: string, orgSlug: string): Promise<{ status: "submitted" }> {
  await consumeRateLimit(db, `join:${userId}`, 3600, 5);
  const slug = orgSlug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) return { status: "submitted" };
  await db.transaction(async (tx) => {
    await setCtx(tx, { userId, orgSlug: slug });
    const [org] = await tx.select({ id: organizations.id }).from(organizations).where(and(eq(organizations.slug, slug), isNull(organizations.deletedAt)));
    if (!org) return;
    await setCtx(tx, { userId, orgId: org.id });
    const inserted = await tx
      .insert(memberships)
      .values({ orgId: org.id, userId, status: "pending" })
      .onConflictDoNothing()
      .returning({ id: memberships.id });
    if (inserted[0]) {
      await tx.insert(auditLogs).values({ orgId: org.id, actorUserId: userId, action: "membership.requested", targetType: "membership", targetId: inserted[0].id });
    }
  });
  return { status: "submitted" };
}

export interface MyMembership {
  membershipId: string;
  status: "pending" | "approved" | "suspended" | "revoked";
  /** Only disclosed once approved. */
  org: { id: string; name: string; slug: string } | null;
}

export async function listMyMemberships(db: Db, userId: string): Promise<MyMembership[]> {
  return db.transaction(async (tx) => {
    await setCtx(tx, { userId });
    const rows = await tx
      .select({ id: memberships.id, status: memberships.status, orgId: organizations.id, name: organizations.name, slug: organizations.slug })
      .from(memberships)
      .leftJoin(organizations, and(eq(organizations.id, memberships.orgId), isNull(organizations.deletedAt)))
      .where(eq(memberships.userId, userId));
    return rows.map((r) => ({
      membershipId: r.id,
      status: r.status,
      org: r.status === "approved" && r.orgId ? { id: r.orgId, name: r.name!, slug: r.slug! } : null,
    }));
  });
}

// ---------------------------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------------------------

export interface CreatedInvitation {
  id: string;
  email: string;
  token: string; // returned once so the caller can email it; only the hash is stored
  expiresAt: Date;
}

export async function createInvitation(s: TenantSession, input: { email: string; roleId: string }): Promise<CreatedInvitation> {
  s.require("org.manage_members");
  const email = input.email.trim().toLowerCase();
  await consumeRateLimit(s.tx as unknown as Db, `invite:${s.orgId}`, 3600, 50);
  await assertCanGrantRole(s, input.roleId, { type: "organization" });
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  const [row] = await s.tx
    .insert(invitations)
    .values({ orgId: s.orgId, email, roleId: input.roleId, tokenHash: sha256Hex(token), invitedBy: s.userId, expiresAt })
    .returning({ id: invitations.id });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "invitation.create", targetType: "invitation", targetId: row!.id });
  return { id: row!.id, email, token, expiresAt };
}

export async function revokeInvitation(s: TenantSession, invitationId: string) {
  s.require("org.manage_members");
  const res = await s.tx
    .update(invitations)
    .set({ revokedAt: new Date() })
    .where(and(eq(invitations.orgId, s.orgId), eq(invitations.id, invitationId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
    .returning({ id: invitations.id });
  if (!res[0]) throw notFound();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "invitation.revoke", targetType: "invitation", targetId: invitationId });
}

export async function listInvitations(s: TenantSession) {
  s.require("org.manage_members");
  return s.tx
    .select({ id: invitations.id, email: invitations.email, roleId: invitations.roleId, expiresAt: invitations.expiresAt, acceptedAt: invitations.acceptedAt, revokedAt: invitations.revokedAt })
    .from(invitations)
    .where(eq(invitations.orgId, s.orgId))
    .orderBy(asc(invitations.createdAt))
    .limit(200);
}

/**
 * Accepts an invitation for the signed-in user. The user's email must equal the invited address and
 * be verified. Every failure mode returns the same NOT_FOUND so tokens cannot be probed.
 */
export async function acceptInvitation(db: Db, user: { id: string; email: string; emailVerified: boolean }, token: string) {
  await consumeRateLimit(db, `accept:${user.id}`, 3600, 10);
  const tokenHash = sha256Hex(token);
  await db.transaction(async (tx) => {
    await setCtx(tx, { userId: user.id, inviteTokenHash: tokenHash });
    const [inv] = await tx.select().from(invitations).where(eq(invitations.tokenHash, tokenHash));
    const ok = inv && !inv.acceptedAt && !inv.revokedAt && inv.expiresAt > new Date() && user.emailVerified && inv.email === user.email.trim().toLowerCase();
    if (!inv || !ok) throw notFound();

    // Claim the invitation atomically; a concurrent accept loses and sees zero rows.
    const claimed = await tx
      .update(invitations)
      .set({ acceptedAt: new Date() })
      .where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .returning({ id: invitations.id });
    if (!claimed[0]) throw notFound();

    await setCtx(tx, { userId: user.id, orgId: inv.orgId, inviteTokenHash: tokenHash });
    const [existing] = await tx.select().from(memberships).where(and(eq(memberships.orgId, inv.orgId), eq(memberships.userId, user.id)));
    let membershipId: string;
    if (existing) {
      membershipId = existing.id;
      await tx.update(memberships).set({ status: "approved", approvedAt: new Date(), approvedBy: inv.invitedBy }).where(eq(memberships.id, existing.id));
    } else {
      const [m] = await tx.insert(memberships).values({ orgId: inv.orgId, userId: user.id, status: "approved", approvedAt: new Date(), approvedBy: inv.invitedBy }).returning({ id: memberships.id });
      membershipId = m!.id;
    }
    const has = await tx.select({ id: roleAssignments.id }).from(roleAssignments).where(and(eq(roleAssignments.membershipId, membershipId), eq(roleAssignments.roleId, inv.roleId), eq(roleAssignments.scopeType, "organization")));
    if (!has[0]) {
      await tx.insert(roleAssignments).values({ orgId: inv.orgId, membershipId, roleId: inv.roleId, scopeType: "organization", createdBy: inv.invitedBy });
    }
    await tx.insert(auditLogs).values({ orgId: inv.orgId, actorUserId: user.id, action: "invitation.accept", targetType: "invitation", targetId: inv.id });
  });
}

// ---------------------------------------------------------------------------------------------
// Members and approvals
// ---------------------------------------------------------------------------------------------

export async function listMembers(s: TenantSession, opts: { status?: "pending" | "approved" | "suspended" | "revoked"; limit?: number; offset?: number } = {}) {
  s.require("org.manage_members");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const where = opts.status ? and(eq(memberships.orgId, s.orgId), eq(memberships.status, opts.status)) : eq(memberships.orgId, s.orgId);
  const rows = await s.tx
    .select({ id: memberships.id, status: memberships.status, userId: users.id, email: users.email, name: users.name, createdAt: memberships.createdAt })
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
    .where(where)
    .orderBy(asc(memberships.createdAt), asc(memberships.id))
    .limit(limit)
    .offset(Math.max(opts.offset ?? 0, 0));
  const ids = rows.map((r) => r.id);
  const assigns = ids.length
    ? await s.tx
        .select({ id: roleAssignments.id, membershipId: roleAssignments.membershipId, roleKey: roles.key, scopeType: roleAssignments.scopeType })
        .from(roleAssignments)
        .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
        .where(and(eq(roleAssignments.orgId, s.orgId), inArray(roleAssignments.membershipId, ids)))
    : [];
  return rows.map((r) => ({ ...r, roles: assigns.filter((a) => a.membershipId === r.id).map(({ membershipId: _m, ...a }) => a) }));
}

async function lockOrgAdmins(tx: Tx, orgId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${"orgadmins:" + orgId}, 0))`);
}

/** Number of APPROVED members with an organization-scope `orgadmin` assignment, excluding one membership. */
async function otherOrgAdmins(tx: Tx, orgId: string, excludeMembershipId: string): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .innerJoin(memberships, eq(memberships.id, roleAssignments.membershipId))
    .where(
      and(
        eq(roleAssignments.orgId, orgId),
        eq(roles.key, "orgadmin"),
        isNull(roles.orgId),
        eq(roleAssignments.scopeType, "organization"),
        eq(memberships.status, "approved"),
        ne(memberships.id, excludeMembershipId),
      ),
    );
  return Number(row?.n ?? 0);
}

export async function approveMembership(s: TenantSession, input: { membershipId: string; roleId: string }) {
  s.require("org.approve_members");
  await lockOrgAdmins(s.tx, s.orgId);
  const [m] = await s.tx.select().from(memberships).where(and(eq(memberships.orgId, s.orgId), eq(memberships.id, input.membershipId)));
  if (!m) throw notFound();
  if (m.status !== "pending") throw conflict("Only pending memberships can be approved");
  await assertCanGrantRole(s, input.roleId, { type: "organization" });
  await s.tx.update(memberships).set({ status: "approved", approvedAt: new Date(), approvedBy: s.userId }).where(eq(memberships.id, m.id));
  await s.tx.insert(roleAssignments).values({ orgId: s.orgId, membershipId: m.id, roleId: input.roleId, scopeType: "organization", createdBy: s.userId });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "membership.approve", targetType: "membership", targetId: m.id, metadata: { roleId: input.roleId } });
}

export async function setMembershipStatus(s: TenantSession, input: { membershipId: string; status: "approved" | "suspended" | "revoked" }) {
  s.require("org.manage_members");
  await lockOrgAdmins(s.tx, s.orgId);
  const [m] = await s.tx.select().from(memberships).where(and(eq(memberships.orgId, s.orgId), eq(memberships.id, input.membershipId)));
  if (!m) throw notFound();
  if (m.status === "pending") throw conflict("Approve pending memberships instead");
  if (input.status !== "approved") {
    if (m.userId === s.userId) throw conflict("You cannot suspend or revoke your own membership");
    if ((await otherOrgAdmins(s.tx, s.orgId, m.id)) === 0 && (await isOrgAdmin(s.tx, m.id))) {
      throw conflict("The organization must keep at least one administrator");
    }
  } else if (m.status === "revoked") {
    throw conflict("A revoked membership must be re-invited");
  }
  await s.tx.update(memberships).set({ status: input.status }).where(eq(memberships.id, m.id));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "membership.status_change", targetType: "membership", targetId: m.id, metadata: { from: m.status, to: input.status } });
}

async function isOrgAdmin(tx: Tx, membershipId: string): Promise<boolean> {
  const [row] = await tx
    .select({ n: count() })
    .from(roleAssignments)
    .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
    .where(and(eq(roleAssignments.membershipId, membershipId), eq(roles.key, "orgadmin"), isNull(roles.orgId), eq(roleAssignments.scopeType, "organization")));
  return Number(row?.n ?? 0) > 0;
}

// ---------------------------------------------------------------------------------------------
// Roles and assignments
// ---------------------------------------------------------------------------------------------

export type AssignScope = { type: "organization" } | { type: "department" | "team" | "project"; id: string };

async function rolePerms(tx: Tx, roleId: string): Promise<Permission[]> {
  const [role] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.id, roleId)); // RLS: system roles + this org's
  if (!role) throw notFound();
  const rows = await tx.select({ p: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  return rows.map((r) => r.p).filter(isPermission);
}

function scopeToResource(scope: AssignScope): Omit<ResourceScope, "orgId"> {
  switch (scope.type) {
    case "organization": return {};
    case "department": return { departmentId: scope.id };
    case "team": return { teamId: scope.id };
    case "project": return { projectId: scope.id };
  }
}

/** No privilege escalation: a granter must already hold every permission of the role at that scope. */
async function assertCanGrantRole(s: TenantSession, roleId: string, scope: AssignScope) {
  const perms = await rolePerms(s.tx, roleId);
  const resource: ResourceScope = { orgId: s.orgId, ...scopeToResource(scope) };
  for (const p of perms) {
    if (!can(s.principal, p, resource)) throw forbidden({ permission: "grant:" + p });
  }
}

export async function assignRole(s: TenantSession, input: { membershipId: string; roleId: string; scope: AssignScope }) {
  s.require("org.manage_roles");
  const [m] = await s.tx.select().from(memberships).where(and(eq(memberships.orgId, s.orgId), eq(memberships.id, input.membershipId)));
  if (!m) throw notFound();
  if (m.status !== "approved") throw conflict("Roles can only be assigned to approved members");
  await assertCanGrantRole(s, input.roleId, input.scope);
  if (input.scope.type !== "organization") {
    const table = { department: departments, team: teams, project: projects }[input.scope.type];
    const [exists] = await s.tx.select({ id: table.id }).from(table).where(and(eq(table.orgId, s.orgId), eq(table.id, input.scope.id), isNull(table.deletedAt)));
    if (!exists) throw notFound();
  }
  const sc = input.scope;
  const [row] = await s.tx
    .insert(roleAssignments)
    .values({
      orgId: s.orgId, membershipId: m.id, roleId: input.roleId, scopeType: sc.type,
      departmentId: sc.type === "department" ? sc.id : null, teamId: sc.type === "team" ? sc.id : null, projectId: sc.type === "project" ? sc.id : null,
      createdBy: s.userId,
    })
    .returning({ id: roleAssignments.id });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "role.assign", targetType: "role_assignment", targetId: row!.id, metadata: { roleId: input.roleId, scope: sc.type } });
  return row!;
}

export async function removeAssignment(s: TenantSession, assignmentId: string) {
  s.require("org.manage_roles");
  await lockOrgAdmins(s.tx, s.orgId);
  const [a] = await s.tx.select().from(roleAssignments).where(and(eq(roleAssignments.orgId, s.orgId), eq(roleAssignments.id, assignmentId)));
  if (!a) throw notFound();
  if (a.scopeType === "organization" && (await isOrgAdmin(s.tx, a.membershipId))) {
    const [role] = await s.tx.select({ key: roles.key, orgId: roles.orgId }).from(roles).where(eq(roles.id, a.roleId));
    if (role?.key === "orgadmin" && role.orgId === null && (await otherOrgAdmins(s.tx, s.orgId, a.membershipId)) === 0) {
      throw conflict("The organization must keep at least one administrator");
    }
  }
  await s.tx.delete(roleAssignments).where(eq(roleAssignments.id, a.id));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "role.unassign", targetType: "role_assignment", targetId: a.id });
}

const roleKey = /^[a-z][a-z0-9_]{1,40}$/;

export async function listRoles(s: TenantSession) {
  s.require("org.manage_roles");
  const rs = await s.tx.select().from(roles).orderBy(asc(roles.isSystem), asc(roles.key)).limit(200);
  const ids = rs.map((r) => r.id);
  const perms = ids.length ? await s.tx.select().from(rolePermissions).where(inArray(rolePermissions.roleId, ids)) : [];
  return rs.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.isSystem, permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission).sort() }));
}

export async function createCustomRole(s: TenantSession, input: { key: string; name: string; permissions: string[] }) {
  s.require("org.manage_roles");
  if (!roleKey.test(input.key) || ["orgadmin", "manager", "member", "viewer", "superadmin", "custom"].includes(input.key)) throw validation("Invalid role key");
  const perms = [...new Set(input.permissions)];
  if (!perms.every(isPermission)) throw validation("Unknown permission");
  for (const p of perms as Permission[]) if (!can(s.principal, p, { orgId: s.orgId })) throw forbidden({ permission: "grant:" + p });
  const [role] = await s.tx.insert(roles).values({ orgId: s.orgId, key: input.key, name: input.name, isSystem: false }).returning({ id: roles.id });
  if (perms.length) await s.tx.insert(rolePermissions).values(perms.map((permission) => ({ roleId: role!.id, permission })));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "role.create", targetType: "role", targetId: role!.id });
  return role!;
}

export async function updateCustomRolePermissions(s: TenantSession, roleId: string, permissions: string[]) {
  s.require("org.manage_roles");
  const [role] = await s.tx.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.orgId, s.orgId)));
  if (!role || role.isSystem) throw notFound();
  const perms = [...new Set(permissions)];
  if (!perms.every(isPermission)) throw validation("Unknown permission");
  for (const p of perms as Permission[]) if (!can(s.principal, p, { orgId: s.orgId })) throw forbidden({ permission: "grant:" + p });
  await s.tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
  if (perms.length) await s.tx.insert(rolePermissions).values(perms.map((permission) => ({ roleId: role.id, permission })));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "role.update", targetType: "role", targetId: role.id });
}

export async function deleteCustomRole(s: TenantSession, roleId: string) {
  s.require("org.manage_roles");
  const [role] = await s.tx.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.orgId, s.orgId)));
  if (!role || role.isSystem) throw notFound();
  const [used] = await s.tx.select({ n: count() }).from(roleAssignments).where(eq(roleAssignments.roleId, role.id));
  if (Number(used?.n ?? 0) > 0) throw conflict("Role is still assigned");
  await s.tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
  await s.tx.delete(roles).where(eq(roles.id, role.id));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "role.delete", targetType: "role", targetId: role.id });
}
