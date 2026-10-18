import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { calendarConnections, integrationDestinations, organizations } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { withWorker, withWorkerOrg } from "@/jobs/context";

export interface RotationReport {
  destinations: number;
  calendarConnections: number;
  alreadyCurrent: number;
  failed: { kind: "destination" | "calendar"; id: string }[];
}

/**
 * Re-encrypts every stored secret (Discord webhook URLs, Google refresh tokens) with the CURRENT key, so the previous
 * key can be retired. `keys` is [current, ...previous], exactly the order the application uses. Idempotent: values
 * that already decrypt with the current key are left untouched. A value that no key can decrypt is reported, never
 * overwritten. Short-lived OAuth state is not rotated (it expires within minutes).
 */
export async function rotateEncryptionKey(db: Db, keys: string[], o: { orgId?: string } = {}): Promise<RotationReport> {
  if (keys.length === 0) throw new Error("at least the current encryption key is required");
  const [current] = keys as [string, ...string[]];
  const report: RotationReport = { destinations: 0, calendarConnections: 0, alreadyCurrent: 0, failed: [] };
  const orgs = await withWorker(db, (tx) => tx.select({ id: organizations.id }).from(organizations).where(o.orgId ? eq(organizations.id, o.orgId) : undefined));

  const reencrypt = (envelope: string, aad: string): { next: string | null; current: boolean } => {
    try { decryptSecret(envelope, [current], aad); return { next: null, current: true }; } catch { /* not under the current key */ }
    const plain = decryptSecret(envelope, keys, aad); // throws if no key works
    return { next: encryptSecret(plain, current, aad), current: false };
  };

  for (const org of orgs) {
    await withWorkerOrg(db, org.id, async (tx) => {
      for (const d of await tx.select({ id: integrationDestinations.id, c: integrationDestinations.webhookCiphertext }).from(integrationDestinations).where(and(eq(integrationDestinations.orgId, org.id), isNull(integrationDestinations.deletedAt)))) {
        try {
          const r = reencrypt(d.c, `dest:${d.id}`);
          if (r.current) { report.alreadyCurrent++; continue; }
          await tx.update(integrationDestinations).set({ webhookCiphertext: r.next! }).where(eq(integrationDestinations.id, d.id));
          report.destinations++;
        } catch { report.failed.push({ kind: "destination", id: d.id }); }
      }
      for (const k of await tx.select({ id: calendarConnections.id, c: calendarConnections.refreshTokenCiphertext }).from(calendarConnections).where(eq(calendarConnections.orgId, org.id))) {
        try {
          const r = reencrypt(k.c, `cal:${k.id}`);
          if (r.current) { report.alreadyCurrent++; continue; }
          await tx.update(calendarConnections).set({ refreshTokenCiphertext: r.next! }).where(eq(calendarConnections.id, k.id));
          report.calendarConnections++;
        } catch { report.failed.push({ kind: "calendar", id: k.id }); }
      }
    });
  }
  return report;
}
