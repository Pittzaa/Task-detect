import { z } from "zod";
import { deleteTask, getTask, updateTask } from "@/data/tasks";
import { handle, readJson } from "@/server/api";
import { updateTaskBody } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; taskId: string }> };
const id = (v: string) => z.string().uuid().parse(v);
export const GET = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; return c.tenant(p.orgId, (s) => getTask(s, id(p.taskId))); });
export const PATCH = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const { version, ...rest } = await readJson(req, updateTaskBody);
    return c.tenant(p.orgId, (s) => updateTask(s, id(p.taskId), { version, ...rest }));
  });
export const DELETE = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; return c.tenant(p.orgId, (s) => deleteTask(s, id(p.taskId))); });
