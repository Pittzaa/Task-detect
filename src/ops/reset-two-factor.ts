import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { auditAuthEvent } from "@/data/account";
import type { Db } from "@/db/client";
import { authTwoFactor, users } from "@/db/schema";

/**
 * Operator recovery: removes two-factor enrolment so the person can sign in with their password and enrol again.
 * Needed after BETTER_AUTH_SECRET is changed (the stored secrets and backup codes are encrypted with it and can no longer be read),
 * or when someone has lost both their authenticator and their backup codes. The operator is trusted to have verified who is asking.
 */
export async function resetTwoFactor(db: Db, who: { email: string } | { all: true; /** Limit "all" to these accounts (for tests that share a database). */ only?: string[] }): Promise<{ email: string }[]> {
  const rows = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where("all" in who ? and(eq(users.twoFactorEnabled, true), isNull(users.deletedAt), who.only ? inArray(users.email, who.only) : undefined) : sql`lower(${users.email}) = ${who.email.trim().toLowerCase()}`);
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  await db.transaction(async (tx) => {
    await tx.delete(authTwoFactor).where(inArray(authTwoFactor.userId, ids));
    await tx.update(users).set({ twoFactorEnabled: false, updatedAt: new Date() }).where(inArray(users.id, ids));
  });
  for (const r of rows) await auditAuthEvent(db, r.id, "auth.two_factor_reset");
  return rows.map((r) => ({ email: r.email }));
}
