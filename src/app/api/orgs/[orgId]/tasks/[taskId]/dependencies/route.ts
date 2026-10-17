import { z } from "zod";
import { addDependency, removeDependency } from "@/data/tasks";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; taskId: string }> };
const body = z.object({ prerequisiteId: uuid }).strict();
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const { prerequisiteId } = await readJson(req, body);
    await c.tenant(p.orgId, (s) => addDependency(s, uuid.parse(p.taskId), prerequisiteId));
    return { ok: true };
  }, { status: 201 });
export const DELETE = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const { prerequisiteId } = await readJson(req, body);
    await c.tenant(p.orgId, (s) => removeDependency(s, uuid.parse(p.taskId), prerequisiteId));
    return { ok: true };
  });
