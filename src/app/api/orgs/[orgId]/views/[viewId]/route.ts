import { z } from "zod";
import { deleteView, getView, updateView } from "@/data/views";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; viewId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; return c.tenant(p.orgId, (s) => getView(s, uuid.parse(p.viewId))); });
export const PATCH = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const body = await readJson(req, z.object({
      name: z.string().min(1).max(80).optional(), kind: z.enum(["list", "board", "calendar", "timeline", "my_tasks"]).optional(),
      scope: z.enum(["personal", "team", "organization"]).optional(), teamId: uuid.nullable().optional(), filter: z.unknown().optional(),
    }).strict());
    return c.tenant(p.orgId, (s) => updateView(s, uuid.parse(p.viewId), body));
  });
export const DELETE = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; await c.tenant(p.orgId, (s) => deleteView(s, uuid.parse(p.viewId))); return { ok: true }; });
