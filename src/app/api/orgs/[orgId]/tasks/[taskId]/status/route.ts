import { z } from "zod";
import { changeStatus } from "@/data/tasks";
import { handle, readJson } from "@/server/api";
import { status } from "@/server/schemas";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string; taskId: string }> }) =>
  handle(req, async (c) => {
    const p = await params;
    const { status: to } = await readJson(req, z.object({ status }).strict());
    return c.tenant(p.orgId, (s) => changeStatus(s, z.string().uuid().parse(p.taskId), to));
  });
