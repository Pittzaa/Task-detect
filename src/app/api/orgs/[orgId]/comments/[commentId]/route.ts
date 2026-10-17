import { z } from "zod";
import { deleteComment, editComment } from "@/data/tasks";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; commentId: string }> };
export const PATCH = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const { body } = await readJson(req, z.object({ body: z.string().min(1).max(10_000) }).strict());
    await c.tenant(p.orgId, (s) => editComment(s, uuid.parse(p.commentId), body));
    return { ok: true };
  });
export const DELETE = (req: Request, { params }: P) =>
  handle(req, async (c) => { const p = await params; await c.tenant(p.orgId, (s) => deleteComment(s, uuid.parse(p.commentId))); return { ok: true }; });
