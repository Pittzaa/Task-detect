import { z } from "zod";
import { approveMembership } from "@/data/account";
import { handle, readJson } from "@/server/api";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string; membershipId: string }> }) =>
  handle(req, async (c) => {
    const { orgId, membershipId } = await params;
    const { roleId } = await readJson(req, z.object({ roleId: z.string().uuid() }).strict());
    await c.tenant(orgId, (s) => approveMembership(s, { membershipId: z.string().uuid().parse(membershipId), roleId }));
    return { ok: true };
  });
