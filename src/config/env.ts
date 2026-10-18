import { z } from "zod";

const optional = z.string().min(1).optional();

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    // Deployment tier. Defaults to "production" whenever NODE_ENV is production, so a deployment that forgets to set it gets the
    // strictest rules. Only automated browser tests set "e2e" (a production build served over http with an email sink).
    APP_ENV: z.enum(["production", "staging", "development", "test", "e2e"]).optional(),
    APP_URL: z.string().url().default("http://localhost:3000"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DATABASE_URL_UNPOOLED: optional,
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    BETTER_AUTH_SECRET: z.string().min(32, "BETTER_AUTH_SECRET must be at least 32 characters").optional(),
    // 32 random bytes, base64. Encrypts webhook URLs and OAuth tokens at rest.
    APP_ENCRYPTION_KEY: optional,
    APP_ENCRYPTION_KEY_PREVIOUS: optional,
    RESEND_API_KEY: optional,
    EMAIL_FROM: optional,
    GOOGLE_CLIENT_ID: optional,
    GOOGLE_CLIENT_SECRET: optional,
    // Google Calendar sync uses a separate OAuth client from sign-in so scopes stay minimal.
    GOOGLE_CALENDAR_CLIENT_ID: optional,
    GOOGLE_CALENDAR_CLIENT_SECRET: optional,
    CRON_SECRET: z.string().min(16).optional(),
    BLOB_READ_WRITE_TOKEN: optional,
    // "off" disables direct browser -> Blob uploads (files are then limited to 4 MB through the server). A kill switch for a path
    // that has not been exercised against a real Blob store by the author.
    DIRECT_UPLOADS: z.enum(["on", "off"]).optional(),
    // Development/E2E only: append outgoing emails to this file instead of sending. Forbidden in production.
    EMAIL_SINK_FILE: optional,
    // Optional error tracking (Sentry-compatible DSN, https only). Unexpected server errors are reported with redacted details.
    SENTRY_DSN: optional,
    APP_RELEASE: optional,
  })
  .superRefine((env, ctx) => {
    const tier = env.APP_ENV ?? (env.NODE_ENV === "production" ? "production" : env.NODE_ENV);
    if (env.EMAIL_SINK_FILE && tier !== "e2e" && tier !== "development" && tier !== "test") ctx.addIssue({ code: "custom", path: ["EMAIL_SINK_FILE"], message: "only allowed in development, test and e2e" });
    if (tier !== "production" && tier !== "staging") return;
    for (const key of ["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "RESEND_API_KEY", "EMAIL_FROM", "CRON_SECRET"] as const) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "required in production" });
    }
    if (env.SENTRY_DSN && !env.SENTRY_DSN.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["SENTRY_DSN"], message: "must be an https DSN" });
    if (!env.APP_URL.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "must be https in production" });
    if (!!env.GOOGLE_CLIENT_ID !== !!env.GOOGLE_CLIENT_SECRET) ctx.addIssue({ code: "custom", path: ["GOOGLE_CLIENT_SECRET"], message: "set both Google sign-in variables or neither" });
    if (!!env.GOOGLE_CALENDAR_CLIENT_ID !== !!env.GOOGLE_CALENDAR_CLIENT_SECRET) ctx.addIssue({ code: "custom", path: ["GOOGLE_CALENDAR_CLIENT_SECRET"], message: "set both Google Calendar variables or neither" });
  });

export type Env = z.infer<typeof schema>;

/** The effective deployment tier (see APP_ENV). */
export const tierOf = (env: Pick<Env, "APP_ENV" | "NODE_ENV">) => env.APP_ENV ?? (env.NODE_ENV === "production" ? "production" : env.NODE_ENV);

let cached: Env | undefined;

/** Parses and caches server-side environment. Never import this from client components. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env && cached) return cached;
  // A blank value (`KEY=` in a copied .env file, or a Vercel variable left empty) means "not set".
  const cleaned = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== undefined && v.trim() !== ""));
  const parsed = schema.safeParse(cleaned);
  if (!parsed.success) {
    // Report variable names only; values may be secrets.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}
