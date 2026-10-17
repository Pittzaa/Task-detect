import { getEnv } from "@/config/env";
import { createDb, type Db } from "@/db/client";
import { createLogSender, createResendSender, type EmailSender } from "@/integrations/email";
import { createBlobStore } from "@/integrations/storage/blob";
import { createFsStore } from "@/integrations/storage/fs";
import type { ObjectStore } from "@/integrations/storage";
import { createGoogleClient, type GoogleClient } from "@/integrations/google-calendar";
import type { JobContext } from "@/jobs/worker";
import { createAuth, type Auth } from "./auth";

export interface Runtime {
  db: Db;
  auth: Auth;
  email: EmailSender;
  store: ObjectStore;
  appUrl: string;
  /** Current encryption key first. Empty when APP_ENCRYPTION_KEY is not configured (secrets features then refuse to run). */
  encryptionKeys: string[];
  google?: GoogleClient;
  jobContext(): JobContext;
}

const KEY = Symbol.for("task-tracker.runtime");
type G = typeof globalThis & { [KEY]?: Runtime };

/** Lazily builds the process-wide runtime. Cached on globalThis so dev hot-reload does not leak pools. */
export function getRuntime(): Runtime {
  const g = globalThis as G;
  if (g[KEY]) return g[KEY]!;
  const env = getEnv();
  const { db } = createDb(env.DATABASE_URL);
  const email =
    env.RESEND_API_KEY && env.EMAIL_FROM
      ? createResendSender({ apiKey: env.RESEND_API_KEY, from: env.EMAIL_FROM })
      : createLogSender();
  const auth = createAuth({
    db,
    baseURL: env.APP_URL,
    secret: env.BETTER_AUTH_SECRET ?? "dev-only-secret-dev-only-secret-0000",
    email,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : undefined,
    production: env.NODE_ENV === "production",
    rateLimit: env.NODE_ENV !== "test",
  });
  // Production must use private Blob storage; the filesystem store is for local development only.
  const store = env.BLOB_READ_WRITE_TOKEN
    ? createBlobStore(env.BLOB_READ_WRITE_TOKEN)
    : env.NODE_ENV === "production"
      ? unavailableStore()
      : createFsStore(".data/uploads");
  const encryptionKeys = [env.APP_ENCRYPTION_KEY, env.APP_ENCRYPTION_KEY_PREVIOUS].filter((k): k is string => !!k);
  const googleCfg = env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET
    ? { clientId: env.GOOGLE_CALENDAR_CLIENT_ID, clientSecret: env.GOOGLE_CALENDAR_CLIENT_SECRET, redirectUri: `${env.APP_URL}/api/calendar/callback` }
    : undefined;
  const rt: Runtime = {
    db, auth, email, store, appUrl: env.APP_URL, encryptionKeys, google: googleCfg ? createGoogleClient(googleCfg) : undefined,
    jobContext: () => ({ db, email, appUrl: env.APP_URL, encryptionKeys, fetchImpl: fetch, google: googleCfg, now: () => new Date() }),
  };
  g[KEY] = rt;
  return rt;
}

/** Test seam: install a prebuilt runtime. */
export function setRuntimeForTests(rt: Runtime | undefined) {
  (globalThis as G)[KEY] = rt;
}

function unavailableStore(): ObjectStore {
  const fail = () => { throw new Error("BLOB_READ_WRITE_TOKEN is not configured; attachments are unavailable"); };
  return { put: fail, get: fail, delete: fail, list: fail };
}
