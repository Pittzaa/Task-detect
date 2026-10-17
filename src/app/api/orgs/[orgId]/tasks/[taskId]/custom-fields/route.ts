import { z } from "zod";
import { setTaskCustomValues } from "@/data/tasks";
import { handle, readJson } from "@/server/api";
import { customValues, uuid } from "@/server/schemas";

export const PUT = (req: Request, { params }: { params: Promise<{ orgId: string; taskId: string }> }) =>
  handle(req, async (c) => {
    const p = await params;
    const { values } = await readJson(req, z.object({ values: customValues }).strict());
    await c.tenant(p.orgId, (s) => setTaskCustomValues(s, uuid.parse(p.taskId), values));
    return { ok: true };
  });
