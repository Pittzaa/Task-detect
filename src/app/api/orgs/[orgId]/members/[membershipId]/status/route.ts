import { z } from "zod";
import { setMembershipStatus } from "@/data/account";
import { handle, readJson } from "@/server/api";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string; membershipId: string }> }) =>
  handle(req, async (c) => {
    const { orgId, membershipId } = await params;
    const { status } = await readJson(req, z.object({ status: z.enum(["approved", "suspended", "revoked"]) }).strict());
    await c.tenant(orgId, (s) => setMembershipStatus(s, { membershipId: z.string().uuid().parse(membershipId), status }));
    return { ok: true };
  });
