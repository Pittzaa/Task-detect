import { getEnv } from "../src/config/env";
import { createDb } from "../src/db/client";
import { createBlobStore } from "../src/integrations/storage/blob";
import { createFsStore } from "../src/integrations/storage/fs";
import { verifyAttachments } from "../src/ops/verify-attachments";

/**
 * Database <-> object storage consistency check (docs/BACKUP_RESTORE.md). Read-only.
 *   tsx scripts/verify-attachments.ts [--hashes] [--org <uuid>]
 * Uses DATABASE_URL (the runtime role) and BLOB_READ_WRITE_TOKEN, or the local .data/uploads store when no token is set.
 */
const env = getEnv();
const { db, close } = createDb(env.DATABASE_URL);
const store = env.BLOB_READ_WRITE_TOKEN ? createBlobStore(env.BLOB_READ_WRITE_TOKEN) : createFsStore(".data/uploads");
console.error(`store checked: ${env.BLOB_READ_WRITE_TOKEN ? "Vercel Blob (BLOB_READ_WRITE_TOKEN)" : "local folder .data/uploads (BLOB_READ_WRITE_TOKEN is not set; this is NOT the production store)"}`);
const orgIdx = process.argv.indexOf("--org");
verifyAttachments(db, store, { hashes: process.argv.includes("--hashes"), orgId: orgIdx > -1 ? process.argv[orgIdx + 1] : undefined })
  .then(async (r) => {
    console.log(JSON.stringify({ ...r, findings: r.findings.length ? r.findings : "none" }, null, 2));
    await close();
    process.exit(r.findings.length ? 1 : 0);
  })
  .catch(async (e) => {
    console.error("verification failed:", e instanceof Error ? e.message : e);
    await close();
    process.exit(2);
  });
