import { z } from "zod";
import { createField, listFields } from "@/data/custom-fields";
import { handle, readJson } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => ({ fields: await c.tenant((await params).orgId, (s) => listFields(s)) }));
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({
      name: z.string().min(1).max(60), type: z.enum(["text", "number", "date", "dropdown", "checkbox"]),
      options: z.array(z.object({ label: z.string().min(1).max(60) })).max(50).optional(),
      minValue: z.number().nullable().optional(), maxValue: z.number().nullable().optional(),
      defaultValue: z.union([z.string(), z.number(), z.boolean()]).nullable().optional(),
    }).strict());
    return c.tenant((await params).orgId, (s) => createField(s, body));
  }, { status: 201 });
