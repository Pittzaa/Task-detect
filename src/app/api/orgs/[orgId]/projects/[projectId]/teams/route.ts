import { z } from "zod";
import { setProjectTeams } from "@/data/structure";
import { handle, readJson } from "@/server/api";

export const PUT = (req: Request, { params }: { params: Promise<{ orgId: string; projectId: string }> }) =>
  handle(req, async (c) => {
    const { orgId, projectId } = await params;
    const { teamIds } = await readJson(req, z.object({ teamIds: z.array(z.string().uuid()).max(50) }).strict());
    await c.tenant(orgId, (s) => setProjectTeams(s, z.string().uuid().parse(projectId), teamIds));
    return { ok: true };
  });
