import { z } from "zod";
import { listMembers } from "@/data/account";
import { handle, readQuery } from "@/server/api";

const q = z.object({
  status: z.enum(["pending", "approved", "suspended", "revoked"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(100_000).optional(),
});

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const { orgId } = await params;
    const query = readQuery(req, q);
    return { members: await c.tenant(orgId, (s) => listMembers(s, query)) };
  });
