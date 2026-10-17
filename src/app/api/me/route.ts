import { eq } from "drizzle-orm";
import { z } from "zod";
import { users } from "@/db/schema";
import { handle, readJson } from "@/server/api";
import { timeZoneSchema } from "@/server/auth";

export const GET = (req: Request) =>
  handle(req, async ({ user }) => ({ id: user.id, email: user.email, name: user.name, locale: user.locale, timezone: user.timezone }));

const patch = z.object({ name: z.string().trim().min(1).max(100).optional(), locale: z.enum(["th", "en"]).optional(), timezone: timeZoneSchema.optional() }).strict();

export const PATCH = (req: Request) =>
  handle(req, async ({ req, db, user }) => {
    const body = await readJson(req, patch);
    if (Object.keys(body).length) await db.update(users).set({ ...body, updatedAt: new Date() }).where(eq(users.id, user.id));
    return { ok: true };
  });
