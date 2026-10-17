import { z } from "zod";
import { restoreTask } from "@/data/tasks";
import { handle } from "@/server/api";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string; taskId: string }> }) =>
  handle(req, async (c) => { const p = await params; return c.tenant(p.orgId, (s) => restoreTask(s, z.string().uuid().parse(p.taskId))); });
