import { z } from "zod";
import { removeAssignment } from "@/data/account";
import { handle } from "@/server/api";

export const DELETE = (req: Request, { params }: { params: Promise<{ orgId: string; assignmentId: string }> }) =>
  handle(req, async (c) => {
    const { orgId, assignmentId } = await params;
    await c.tenant(orgId, (s) => removeAssignment(s, z.string().uuid().parse(assignmentId)));
    return { ok: true };
  });
