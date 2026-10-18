import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import { eraseMyAccount } from "@/data/privacy";
import { handle, readJson } from "@/server/api";
import { displayNameSchema, timeZoneSchema } from "@/server/auth";

export const GET = (req: Request) =>
  handle(req, async ({ user }) => ({ id: user.id, email: user.email, name: user.name, locale: user.locale, timezone: user.timezone }));

const patch = z.object({ name: displayNameSchema.optional(), locale: z.enum(["th", "en"]).optional(), timezone: timeZoneSchema.optional() }).strict();

export const PATCH = (req: Request) =>
  handle(req, async ({ req, db, user }) => {
    const body = await readJson(req, patch);
    if (Object.keys(body).length) await db.update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, user.id));
    return { ok: true };
  });

const erase = z.object({ confirmEmail: z.string().trim().min(3).max(320), password: z.string().max(128).optional(), abandonOrganizations: z.boolean().optional() }).strict();

/** Erases the signed-in user's personal data (see `eraseMyAccount`). Needs the password (or a recent sign-in) and the typed e-mail address. */
export const DELETE = (req: Request) =>
  handle(
    req,
    async ({ req, db, user, sessionCreatedAt }) => {
      const body = await readJson(req, erase);
      return eraseMyAccount(db, { id: user.id, email: user.email }, { ...body, sessionCreatedAt });
    },
    { limit: { name: "me-erase", windowSeconds: 3600, max: 6 } },
  );
