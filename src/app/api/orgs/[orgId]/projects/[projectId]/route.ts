import { z } from "zod";
import { getProject } from "@/data/structure";
import { handle } from "@/server/api";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string; projectId: string }> }) =>
  handle(req, async (c) => {
    const { orgId, projectId } = await params;
    return c.tenant(orgId, (s) => getProject(s, z.string().uuid().parse(projectId)));
  });
