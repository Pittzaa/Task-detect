import { z } from "zod";
import { addComment, listComments } from "@/data/tasks";
import { handle, readJson, readQuery } from "@/server/api";
import { pageQuery, uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; taskId: string }> };
export const GET = (req: Request, { params }: P) =>
  handle(req, async (c) => { const p = await params; const q = readQuery(req, pageQuery); return { comments: await c.tenant(p.orgId, (s) => listComments(s, uuid.parse(p.taskId), q)) }; });
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const body = await readJson(req, z.object({ body: z.string().min(1).max(10_000), mentionUserIds: z.array(uuid).max(20).optional() }).strict());
    return c.tenant(p.orgId, (s) => addComment(s, uuid.parse(p.taskId), body));
  }, { status: 201, limit: { name: "comment", windowSeconds: 60, max: 60 } });
