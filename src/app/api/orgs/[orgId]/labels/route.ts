import { z } from "zod";
import { createLabel, listLabels } from "@/data/tasks";
import { handle, readJson } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => ({ labels: await c.tenant((await params).orgId, (s) => listLabels(s)) }));
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({ name: z.string().min(1).max(50), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() }).strict());
    return c.tenant((await params).orgId, (s) => createLabel(s, body));
  }, { status: 201 });
