import { z } from "zod";
import { deleteDestination, updateDestination } from "@/data/integrations";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; destinationId: string }> };
export const PATCH = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const body = await readJson(req, z.object({ name: z.string().min(1).max(80).optional(), events: z.array(z.string().max(40)).max(10).optional(), includeDetails: z.boolean().optional(), enabled: z.boolean().optional() }).strict());
    await c.tenant(p.orgId, (s) => updateDestination(s, uuid.parse(p.destinationId), body));
    return { ok: true };
  });
export const DELETE = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; await c.tenant(p.orgId, (s) => deleteDestination(s, uuid.parse(p.destinationId))); return { ok: true }; });
