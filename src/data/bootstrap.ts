import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { auditLogs, invitations, organizations, roles, users } from "@/db/schema";
import { randomToken, sha256Hex } from "@/lib/crypto";
import { syncSystemRoles } from "./system-roles";

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

/**
 * Operator-only (runs with the owner/admin database role, never from a request): creates an
 * organization and an `orgadmin` invitation for its first administrator.
 */
export async function bootstrapOrganization(db: Db, input: { name: string; slug: string; adminEmail: string; appUrl: string }) {
  if (!SLUG.test(input.slug)) throw new Error("slug must be lowercase letters, digits and dashes (2-63 chars)");
  const adminEmail = input.adminEmail.trim().toLowerCase();
  const roleIds = await syncSystemRoles(db);
  return db.transaction(async (tx) => {
    let [org] = await tx.select().from(organizations).where(eq(organizations.slug, input.slug));
    if (!org) [org] = await tx.insert(organizations).values({ name: input.name, slug: input.slug }).returning();
    const token = randomToken();
    await tx.insert(invitations).values({
      orgId: org!.id, email: adminEmail, roleId: roleIds.get("orgadmin")!, tokenHash: sha256Hex(token),
      invitedBy: null, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
    await tx.insert(auditLogs).values({ orgId: org!.id, action: "org.bootstrap", targetType: "organization", targetId: org!.id });
    return { orgId: org!.id, inviteUrl: `${input.appUrl}/invite?token=${encodeURIComponent(token)}` };
  });
}

/** Marks an existing user as a platform administrator (reserved flag; grants no organization access). */
export async function setPlatformAdmin(db: Db, email: string, value = true) {
  const res = await db
    .update(users)
    .set({ isPlatformAdmin: value })
    .where(and(eq(users.email, email.trim().toLowerCase()), isNull(users.deletedAt)))
    .returning({ id: users.id });
  if (!res[0]) throw new Error("user not found");
}
