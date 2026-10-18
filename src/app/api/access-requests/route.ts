import { z } from "zod";
import { requestAccess } from "@/data/account";
import { handle, readJson } from "@/server/api";

export const POST = (req: Request) =>
  handle(req, async ({ req, db, user }) => {
    const { orgSlug } = await readJson(req, z.object({ orgSlug: z.string().min(1).max(64).optional() }).strict());
    return requestAccess(db, user.id, orgSlug);
  }, { status: 202 });
