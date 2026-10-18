import { getEnv } from "../src/config/env";
import { createDb } from "../src/db/client";
import type { ObjectStore } from "../src/integrations/storage";
import { createBlobStore } from "../src/integrations/storage/blob";
import { createFsStore } from "../src/integrations/storage/fs";
import { syncAttachments } from "../src/ops/backup-attachments";

/**
 * Attachment FILES are not covered by a database backup. This copies every file the database references into a second store, or back.
 *   pnpm backup:attachments --to fs:/mnt/backup/attachments        # backup (incremental; writes manifests/<time> into the destination)
 *   pnpm backup:attachments --to blob                              # a second Vercel Blob store: BACKUP_BLOB_READ_WRITE_TOKEN
 *   pnpm backup:attachments --restore --from fs:/mnt/backup/attachments   # AFTER restoring the database: copy missing/damaged files back
 * Options: --org <uuid>  --dry-run  --verify (re-download existing copies and check their SHA-256; slow on a hosted store)
 * The live store is BLOB_READ_WRITE_TOKEN, or .data/uploads when no token is set. Uses DATABASE_URL (the runtime role).
 * Exit code 1 when a problem was found (missing/corrupt source, failed copy). Nothing is ever deleted. See docs/BACKUP_RESTORE.md §2.3.
 */
function parseStore(spec: string | undefined, what: string): ObjectStore {
  if (!spec) throw new Error(`${what}: expected fs:<directory> or blob`);
  if (spec.startsWith("fs:")) return createFsStore(spec.slice(3));
  if (spec === "blob") {
    const token = process.env.BACKUP_BLOB_READ_WRITE_TOKEN;
    if (!token) throw new Error("BACKUP_BLOB_READ_WRITE_TOKEN is required for --to/--from blob (a SECOND store, not the live one)");
    if (token === process.env.BLOB_READ_WRITE_TOKEN) throw new Error("BACKUP_BLOB_READ_WRITE_TOKEN equals BLOB_READ_WRITE_TOKEN: that would copy the store onto itself");
    return createBlobStore(token);
  }
  throw new Error(`${what}: unknown store "${spec}" (use fs:<directory> or blob)`);
}
const arg = (name: string) => { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : undefined; };

const env = getEnv();
const live: ObjectStore = env.BLOB_READ_WRITE_TOKEN ? createBlobStore(env.BLOB_READ_WRITE_TOKEN) : createFsStore(".data/uploads");
const restore = process.argv.includes("--restore");
const other = parseStore(restore ? arg("--from") : arg("--to"), restore ? "--from" : "--to");
const { db, close } = createDb(env.DATABASE_URL);

try {
  const report = await syncAttachments(db, restore ? other : live, restore ? live : other, {
    orgId: arg("--org"), dryRun: process.argv.includes("--dry-run"), verify: process.argv.includes("--verify"), manifest: !restore,
    onProgress: (n) => { if (n % 100 === 0) console.error(`… ${n} attachments`); },
  });
  console.log(JSON.stringify({ direction: restore ? "restore (backup → live)" : "backup (live → backup)", dryRun: process.argv.includes("--dry-run"), ...report, problems: report.problems.length ? report.problems : "none" }, null, 2));
  await close();
  process.exit(report.problems.length ? 1 : 0);
} catch (e) {
  console.error("attachment copy failed:", e instanceof Error ? e.message : e);
  await close();
  process.exit(2);
}
