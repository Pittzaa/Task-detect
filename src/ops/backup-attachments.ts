import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { attachments, organizations } from "@/db/schema";
import type { ObjectStore } from "@/integrations/storage";
import { withWorker, withWorkerOrg } from "@/jobs/context";

export type AttachmentOutcome =
  | "copied"
  /** Already in the destination with the right size (and hash, with `verify`). */
  | "present"
  /** The source has no such object. Nothing can be copied; the database row points at a lost file. */
  | "source_missing"
  /** The source object does not match the size/hash the database recorded: it is NOT copied, so a bad file never overwrites a good backup. */
  | "source_corrupt"
  /** The copy was written but reading it back did not match. */
  | "copy_failed";

export interface AttachmentCopyReport {
  organizations: number;
  rows: number;
  counts: Record<AttachmentOutcome, number>;
  bytesCopied: number;
  problems: { orgId: string; attachmentId: string; key: string; outcome: AttachmentOutcome }[];
  /** Objects in the destination that no database row references (kept: a restored older database may still need them). */
  destinationOnly: number;
  manifestKey?: string;
}

async function readAll(obj: { stream: ReadableStream<Uint8Array> }): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  const reader = obj.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/**
 * Makes sure every attachment the DATABASE knows about exists, intact, in `to`, by copying from `from`.
 *
 * The same function is the backup and the restore, only the direction differs:
 *   backup:  from = live store,   to = backup store   (writes a manifest into the backup store)
 *   restore: from = backup store, to = live store     (run AFTER the database has been restored, so its rows say what must exist)
 *
 * Objects are immutable (a key is never rewritten), so an object that is already present with the right size is skipped: runs are
 * incremental. A source object is copied only if it matches the size and SHA-256 recorded in the database. Nothing is ever deleted.
 */
export async function syncAttachments(
  db: Db,
  from: ObjectStore,
  to: ObjectStore,
  o: { orgId?: string; dryRun?: boolean; /** also re-download present copies and check their hash */ verify?: boolean; manifest?: boolean; now?: Date; onProgress?: (done: number) => void } = {},
): Promise<AttachmentCopyReport> {
  const orgs = await withWorker(db, (tx) => tx.select({ id: organizations.id }).from(organizations).where(o.orgId ? eq(organizations.id, o.orgId) : undefined));
  const report: AttachmentCopyReport = {
    organizations: orgs.length, rows: 0, bytesCopied: 0, problems: [], destinationOnly: 0,
    counts: { copied: 0, present: 0, source_missing: 0, source_corrupt: 0, copy_failed: 0 },
  };
  const manifest: { orgId: string; attachmentId: string; key: string; size: number; sha256: string; outcome: AttachmentOutcome }[] = [];

  for (const org of orgs) {
    const rows = await withWorkerOrg(db, org.id, (tx) =>
      tx.select({ id: attachments.id, key: attachments.storageKey, size: attachments.sizeBytes, sha256: attachments.sha256 }).from(attachments).where(eq(attachments.orgId, org.id)),
    );
    for (const row of rows) {
      report.rows++;
      const outcome = await syncOne(row, from, to, o);
      report.counts[outcome.kind]++;
      if (outcome.kind === "copied") report.bytesCopied += row.size;
      if (outcome.kind !== "copied" && outcome.kind !== "present") report.problems.push({ orgId: org.id, attachmentId: row.id, key: row.key, outcome: outcome.kind });
      manifest.push({ orgId: org.id, attachmentId: row.id, key: row.key, size: row.size, sha256: row.sha256, outcome: outcome.kind });
      o.onProgress?.(report.rows);
    }
    const known = new Set(rows.map((r) => r.key));
    report.destinationOnly += (await to.list(`orgs/${org.id}/`)).filter((x) => !known.has(x.key)).length;
  }

  if (o.manifest && !o.dryRun) {
    const stamp = (o.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const key = `manifests/${stamp}`;
    await to.put(key, Buffer.from(JSON.stringify({ createdAt: (o.now ?? new Date()).toISOString(), counts: report.counts, rows: manifest }, null, 1)));
    report.manifestKey = key;
  }
  return report;
}

async function syncOne(
  row: { key: string; size: number; sha256: string },
  from: ObjectStore,
  to: ObjectStore,
  o: { dryRun?: boolean; verify?: boolean },
): Promise<{ kind: AttachmentOutcome }> {
  const existing = await to.get(row.key);
  if (existing) {
    let ok = existing.size === row.size;
    if (ok && o.verify) ok = sha256(await readAll(existing)) === row.sha256;
    else await existing.stream.cancel().catch(() => undefined);
    if (ok) return { kind: "present" };
  }
  const source = await from.get(row.key);
  if (!source) return { kind: "source_missing" };
  const bytes = await readAll(source);
  if (bytes.byteLength !== row.size || sha256(bytes) !== row.sha256) return { kind: "source_corrupt" };
  if (o.dryRun) return { kind: "copied" };

  if (existing) await to.delete(row.key); // a damaged copy is replaced (stores refuse to overwrite)
  await to.put(row.key, bytes);
  const back = await to.get(row.key);
  if (!back) return { kind: "copy_failed" };
  const check = await readAll(back);
  return { kind: check.byteLength === row.size && sha256(check) === row.sha256 ? "copied" : "copy_failed" };
}
