import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { attachments, organizations } from "@/db/schema";
import type { ObjectStore } from "@/integrations/storage";
import { withWorker, withWorkerOrg } from "@/jobs/context";

export interface AttachmentFinding {
  orgId: string;
  attachmentId: string;
  problem: "missing_object" | "size_mismatch" | "hash_mismatch";
}

export interface AttachmentReport {
  organizations: number;
  rows: number;
  checkedHashes: number;
  findings: AttachmentFinding[];
  /** Objects present in storage that no row references. Informational: the orphan sweep removes them after its grace period. */
  unreferencedObjects: number;
}

/**
 * Compares the database with object storage. Run it after restoring the database (a restore to an earlier point can
 * reference files that were deleted since) and periodically as a health check. Read-only: it never deletes or repairs.
 * With `hashes` it also downloads every object and verifies its SHA-256 (costly on a hosted store: use sparingly).
 */
export async function verifyAttachments(db: Db, store: ObjectStore, o: { hashes?: boolean; orgId?: string } = {}): Promise<AttachmentReport> {
  const orgs = await withWorker(db, (tx) => tx.select({ id: organizations.id }).from(organizations).where(o.orgId ? eq(organizations.id, o.orgId) : undefined));
  const report: AttachmentReport = { organizations: orgs.length, rows: 0, checkedHashes: 0, findings: [], unreferencedObjects: 0 };
  for (const org of orgs) {
    const rows = await withWorkerOrg(db, org.id, (tx) =>
      tx.select({ id: attachments.id, key: attachments.storageKey, size: attachments.sizeBytes, sha256: attachments.sha256 }).from(attachments).where(and(eq(attachments.orgId, org.id))),
    );
    report.rows += rows.length;
    for (const row of rows) {
      const obj = await store.get(row.key);
      if (!obj) { report.findings.push({ orgId: org.id, attachmentId: row.id, problem: "missing_object" }); continue; }
      if (!o.hashes) {
        await obj.stream.cancel().catch(() => undefined);
        if (obj.size !== row.size) report.findings.push({ orgId: org.id, attachmentId: row.id, problem: "size_mismatch" });
        continue;
      }
      const hash = createHash("sha256");
      let size = 0;
      const reader = obj.stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        hash.update(value);
      }
      report.checkedHashes++;
      if (size !== row.size) report.findings.push({ orgId: org.id, attachmentId: row.id, problem: "size_mismatch" });
      else if (hash.digest("hex") !== row.sha256) report.findings.push({ orgId: org.id, attachmentId: row.id, problem: "hash_mismatch" });
    }
    const known = new Set(rows.map((r) => r.key));
    report.unreferencedObjects += (await store.list(`orgs/${org.id}/`)).filter((x) => !known.has(x.key)).length;
  }
  return report;
}
