import { getEnv } from "@/config/env";
import { createDb, type Db } from "@/db/client";
import { createLogSender, createResendSender, type EmailSender } from "@/integrations/email";
import { createAuth, type Auth } from "./auth";

export interface Runtime {
  db: Db;
  auth: Auth;
  email: EmailSender;
  appUrl: string;
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
  g[KEY] = { db, auth, email, appUrl: env.APP_URL };
  return g[KEY]!;
}

/** Test seam: install a prebuilt runtime. */
export function setRuntimeForTests(rt: Runtime | undefined) {
  (globalThis as G)[KEY] = rt;
}
