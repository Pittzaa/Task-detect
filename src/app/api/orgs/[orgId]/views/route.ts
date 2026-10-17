import { z } from "zod";
import { createView, listViews } from "@/data/views";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => ({ views: await c.tenant((await params).orgId, (s) => listViews(s)) }));
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({
      name: z.string().min(1).max(80), kind: z.enum(["list", "board", "calendar", "timeline", "my_tasks"]),
      scope: z.enum(["personal", "team", "organization"]), teamId: uuid.nullable().optional(), filter: z.unknown(),
    }).strict());
    return c.tenant((await params).orgId, (s) => createView(s, body));
  }, { status: 201 });
