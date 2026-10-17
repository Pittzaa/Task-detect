import { getEnv } from "../src/config/env";
import { createDb } from "../src/db/client";
import { rotateEncryptionKey } from "../src/ops/rotate-encryption";

/**
 * Key rotation (docs/SECURITY.md). Steps: 1) generate a new key, 2) set APP_ENCRYPTION_KEY to it and
 * APP_ENCRYPTION_KEY_PREVIOUS to the old one, 3) deploy, 4) run this script, 5) when it reports no failures,
 * remove APP_ENCRYPTION_KEY_PREVIOUS and deploy again.
 *   DATABASE_URL=... APP_ENCRYPTION_KEY=... APP_ENCRYPTION_KEY_PREVIOUS=... pnpm rotate:key
 */
const env = getEnv();
const keys = [env.APP_ENCRYPTION_KEY, env.APP_ENCRYPTION_KEY_PREVIOUS].filter((k): k is string => !!k);
const { db, close } = createDb(env.DATABASE_URL);
rotateEncryptionKey(db, keys)
  .then(async (r) => {
    console.log(JSON.stringify({ ...r, failed: r.failed.length ? r.failed : "none" }, null, 2));
    await close();
    process.exit(r.failed.length ? 1 : 0);
  })
  .catch(async (e) => { console.error("rotation failed:", e instanceof Error ? e.message : e); await close(); process.exit(2); });
