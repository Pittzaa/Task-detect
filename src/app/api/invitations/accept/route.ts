import { z } from "zod";
import { acceptInvitation } from "@/data/account";
import { handle, readJson } from "@/server/api";

export const POST = (req: Request) =>
  handle(req, async ({ req, db, user }) => {
    const { token } = await readJson(req, z.object({ token: z.string().min(20).max(200) }).strict());
    await acceptInvitation(db, user, token);
    return { ok: true };
  });
