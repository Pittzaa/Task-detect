import { and, eq, isNull, sql } from "drizzle-orm";
import { SYSTEM_ROLE_KEYS, SYSTEM_ROLE_PERMISSIONS } from "@/authz/permissions";
import type { Db } from "@/db/client";
import { rolePermissions, roles } from "@/db/schema";

/**
 * Idempotently makes the system roles in the database match the code catalog.
 * Run with the migration/admin role (system roles have no org, so tenant policies deny writes).
 */
export async function syncSystemRoles(db: Db): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  await db.transaction(async (tx) => {
    // Two runs at once (two operators, or a script racing a bootstrap) would both delete and re-insert the same permission rows
    // and one would fail on the primary key. They take turns instead.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('task-tracker:system-roles'))`);
    for (const key of SYSTEM_ROLE_KEYS) {
      let [role] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(and(isNull(roles.orgId), eq(roles.key, key)));
      if (!role) {
        [role] = await tx.insert(roles).values({ key, name: key, isSystem: true }).returning({ id: roles.id });
      }
      ids.set(key, role!.id);
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role!.id));
      await tx
        .insert(rolePermissions)
        .values(SYSTEM_ROLE_PERMISSIONS[key].map((permission) => ({ roleId: role!.id, permission })));
    }
  });
  return ids;
}
