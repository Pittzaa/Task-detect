import { z } from "zod";

const optional = z.string().min(1).optional();

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
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
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV !== "production") return;
    for (const key of ["BETTER_AUTH_SECRET", "APP_ENCRYPTION_KEY", "RESEND_API_KEY", "EMAIL_FROM", "CRON_SECRET"] as const) {
      if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "required in production" });
    }
    if (!env.APP_URL.startsWith("https://")) ctx.addIssue({ code: "custom", path: ["APP_URL"], message: "must be https in production" });
    if (!!env.GOOGLE_CLIENT_ID !== !!env.GOOGLE_CLIENT_SECRET) ctx.addIssue({ code: "custom", path: ["GOOGLE_CLIENT_SECRET"], message: "set both Google sign-in variables or neither" });
    if (!!env.GOOGLE_CALENDAR_CLIENT_ID !== !!env.GOOGLE_CALENDAR_CLIENT_SECRET) ctx.addIssue({ code: "custom", path: ["GOOGLE_CALENDAR_CLIENT_SECRET"], message: "set both Google Calendar variables or neither" });
  });

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

/** Parses and caches server-side environment. Never import this from client components. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env && cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Report variable names only; values may be secrets.
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))].join(", ");
    throw new Error(`Invalid environment configuration: ${names}`);
  }
  if (source === process.env) cached = parsed.data;
  return parsed.data;
}
