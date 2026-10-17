import { z } from "zod";
import { archiveField, updateField } from "@/data/custom-fields";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; fieldId: string }> };
export const PATCH = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const body = await readJson(req, z.object({
      name: z.string().min(1).max(60).optional(),
      options: z.array(z.object({ id: z.string().max(40).optional(), label: z.string().min(1).max(60), archived: z.boolean().optional() })).max(50).optional(),
      minValue: z.number().nullable().optional(), maxValue: z.number().nullable().optional(),
      defaultValue: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
    }).strict());
    return c.tenant(p.orgId, (s) => updateField(s, uuid.parse(p.fieldId), body));
  });
export const DELETE = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; await c.tenant(p.orgId, (s) => archiveField(s, uuid.parse(p.fieldId))); return { ok: true }; });
