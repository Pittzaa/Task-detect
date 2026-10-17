import { z } from "zod";
import { assignRole } from "@/data/account";
import { handle, readJson } from "@/server/api";

const body = z
  .object({
    membershipId: z.string().uuid(),
    roleId: z.string().uuid(),
    scope: z.discriminatedUnion("type", [
      z.object({ type: z.literal("organization") }),
      z.object({ type: z.enum(["department", "team", "project"]), id: z.string().uuid() }),
    ]),
  })
  .strict();

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => c.tenant((await params).orgId, async (s) => assignRole(s, await readJson(req, body))), { status: 201 });
