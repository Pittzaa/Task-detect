import { z } from "zod";
import { setAssignees } from "@/data/tasks";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

export const PUT = (req: Request, { params }: { params: Promise<{ orgId: string; taskId: string }> }) =>
  handle(req, async (c) => {
    const p = await params;
    const body = await readJson(req, z.object({ primary: uuid.nullable(), co: z.array(uuid).max(20) }).strict());
    return c.tenant(p.orgId, (s) => setAssignees(s, uuid.parse(p.taskId), body));
  });
