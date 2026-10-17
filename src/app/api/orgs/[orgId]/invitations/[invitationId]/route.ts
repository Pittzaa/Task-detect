import { z } from "zod";
import { revokeInvitation } from "@/data/account";
import { handle } from "@/server/api";

export const DELETE = (req: Request, { params }: { params: Promise<{ orgId: string; invitationId: string }> }) =>
  handle(req, async (c) => {
    const { orgId, invitationId } = await params;
    await c.tenant(orgId, (s) => revokeInvitation(s, z.string().uuid().parse(invitationId)));
    return { ok: true };
  });
