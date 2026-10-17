import { z } from "zod";
import { setTaskLabels } from "@/data/tasks";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

export const PUT = (req: Request, { params }: { params: Promise<{ orgId: string; taskId: string }> }) =>
  handle(req, async (c) => {
    const p = await params;
    const { labelIds } = await readJson(req, z.object({ labelIds: z.array(uuid).max(20) }).strict());
    await c.tenant(p.orgId, (s) => setTaskLabels(s, uuid.parse(p.taskId), labelIds));
    return { ok: true };
  });
