import { createBlobStore } from "./blob";
import { createFsStore } from "./fs";
import type { ObjectStore } from "./index";

/**
 * Where attachment files live:
 *  - BLOB_READ_WRITE_TOKEN → a private Vercel Blob store (hosting on Vercel);
 *  - ATTACHMENTS_DIR       → a directory on this server (self-hosting on a VPS: back it up together with the database);
 *  - neither               → production-like tiers refuse uploads (a serverless disk is ephemeral), development uses .data/uploads.
 */
export function selectStore(env: { BLOB_READ_WRITE_TOKEN?: string; ATTACHMENTS_DIR?: string }, tier: string): ObjectStore {
  if (env.BLOB_READ_WRITE_TOKEN) return createBlobStore(env.BLOB_READ_WRITE_TOKEN);
  if (env.ATTACHMENTS_DIR) return createFsStore(env.ATTACHMENTS_DIR);
  if (tier === "production" || tier === "staging") return unavailableStore();
  return createFsStore(".data/uploads");
}

function unavailableStore(): ObjectStore {
  const fail = () => { throw new Error("neither BLOB_READ_WRITE_TOKEN nor ATTACHMENTS_DIR is configured; attachments are unavailable"); };
  return { put: fail, get: fail, delete: fail, list: fail };
}
