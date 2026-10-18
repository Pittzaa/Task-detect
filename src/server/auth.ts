import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { twoFactor } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/client";
import { authAccounts, authRateLimits, authSessions, authTwoFactor, authVerifications, users } from "@/db/schema";
import type { EmailSender } from "@/integrations/email";
import { DEFAULT_LOCALE, isLocale, t, type Locale } from "@/i18n";
import { describeError } from "@/lib/error-report";
import { logger } from "@/lib/logger";
import { auditAuthEvent } from "@/data/account";
import { canRegister } from "./registration";

export interface AuthDeps {
  db: Db;
  baseURL: string;
  secret: string;
  email: EmailSender;
  google?: { clientId: string; clientSecret: string };
  /** Disable only in tests that do not exercise throttling. */
  rateLimit?: boolean;
  production?: boolean;
}

export const timeZoneSchema = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, "invalid time zone");

/** Control, bidi and line-separator characters have no place in a name that is shown in lists and put into e-mails and chat messages. */
const NAME_FORBIDDEN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u200e\\u200f\\u2028-\\u202e\\u2066-\\u2069]");
export const displayNameSchema = z.string().trim().min(1).max(100).refine((v) => !NAME_FORBIDDEN.test(v), "invalid characters");
const imageSchema = z.string().max(2048);

/** Better Auth writes `name` and `image` as it receives them; this is the one place that bounds them, for sign-up and update-user alike. */
function checkProfile<T extends { name?: unknown; image?: unknown }>(user: T, partial: boolean): T {
  const out = { ...user };
  if (!partial || out.name !== undefined) {
    const name = displayNameSchema.safeParse(out.name);
    if (!name.success) throw new APIError("BAD_REQUEST", { message: "Name must be 1-100 characters without control characters", code: "INVALID_NAME" });
    out.name = name.data;
  }
  if (out.image !== undefined && out.image !== null && !imageSchema.safeParse(out.image).success) {
    throw new APIError("BAD_REQUEST", { message: "Image address is too long", code: "INVALID_IMAGE" });
  }
  return out;
}

export function cleanProviderName(name: unknown, email: string): string {
  const cleaned = String(name ?? "").replace(new RegExp(NAME_FORBIDDEN.source, "g"), " ").replace(/\s+/g, " ").trim().slice(0, 100).trim();
  return cleaned || email.split("@")[0]!.slice(0, 100) || "User";
}

export function createAuth(deps: AuthDeps) {
  const { db, email } = deps;
  const app = t(DEFAULT_LOCALE, "app.name");

  const localeOf = (u: { locale?: unknown }): Locale => (isLocale(u.locale) ? u.locale : DEFAULT_LOCALE);

  return betterAuth({
    baseURL: deps.baseURL,
    secret: deps.secret,
    trustedOrigins: [deps.baseURL],
    database: drizzleAdapter(db as never, {
      provider: "pg",
      schema: {
        user: users,
        session: authSessions,
        account: authAccounts,
        verification: authVerifications,
        twoFactor: authTwoFactor,
        rateLimit: authRateLimits,
      },
    }),
    advanced: {
      database: { generateId: "uuid" },
      useSecureCookies: deps.production ?? false,
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 60 * 60,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, url }) => {
        const locale = localeOf(user as { locale?: unknown });
        await email.send({
          to: user.email,
          subject: t(locale, "email.reset.subject", { app }),
          text: t(locale, "email.reset.body", { name: user.name, url }),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        const locale = localeOf(user as { locale?: unknown });
        await email.send({
          to: user.email,
          subject: t(locale, "email.verify.subject", { app }),
          text: t(locale, "email.verify.body", { name: user.name, url }),
        });
      },
    },
    socialProviders: deps.google ? { google: { clientId: deps.google.clientId, clientSecret: deps.google.clientSecret } } : {},
    session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24 },
    user: {
      additionalFields: {
        locale: { type: "string", required: false, defaultValue: DEFAULT_LOCALE, input: true, validator: { input: z.enum(["th", "en"]) } },
        timezone: { type: "string", required: false, defaultValue: "Asia/Bangkok", input: true, validator: { input: timeZoneSchema } },
      },
    },
    plugins: [twoFactor({ issuer: app })],
    rateLimit: {
      enabled: deps.rateLimit ?? true,
      storage: "database",
      window: 60,
      max: 100,
      customRules: {
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 10 },
        "/request-password-reset": { window: 3600, max: 5 },
        "/reset-password": { window: 3600, max: 10 },
        "/change-password": { window: 60, max: 5 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
        "/send-verification-email": { window: 3600, max: 5 },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            // The registration switch: once an administrator closes it, only an address with a pending invitation gets an account.
            if (!(await canRegister(db, user.email))) throw new APIError("FORBIDDEN", { message: "Registration is closed", code: "REGISTRATION_CLOSED" });
            // A name chosen by a person is refused; one handed over by Google is cleaned instead, so that an unusual display
            // name there cannot make sign-in fail.
            if (ctx?.path?.startsWith("/callback")) return { data: { ...user, name: cleanProviderName(user.name, user.email) } };
            return { data: checkProfile(user, false) };
          },
        },
        update: { before: async (user) => ({ data: checkProfile(user, true) }) },
      },
      session: {
        create: {
          before: async (session) => {
            // Block deleted accounts from obtaining sessions.
            const row = await db.select({ deletedAt: users.deletedAt }).from(users).where(eqId(session.userId));
            if (!row[0] || row[0].deletedAt) return false;
            return undefined;
          },
          after: async (session) => {
            try {
              await auditAuthEvent(db, session.userId, "auth.login");
            } catch (e) {
              logger.error({ error: describeError(e) }, "failed to audit login");
            }
          },
        },
      },
    },
  });
}

const eqId = (id: string) => eq(users.id, id);

export type Auth = ReturnType<typeof createAuth>;
