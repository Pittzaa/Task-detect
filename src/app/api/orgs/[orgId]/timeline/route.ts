import { z } from "zod";
import { getTimeline } from "@/data/timeline";
import { handle, readQuery } from "@/server/api";
import { dateOnly, uuid } from "@/server/schemas";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const q = readQuery(req, z.object({ from: dateOnly, to: dateOnly, projectId: uuid.optional(), assignee: z.union([z.literal("me"), uuid]).optional() }));
    if (q.to < q.from) return new Response(JSON.stringify({ error: { code: "VALIDATION", message: "to must not precede from" } }), { status: 422, headers: { "content-type": "application/json" } });
    return c.tenant((await params).orgId, (s) => getTimeline(s, { rangeFrom: q.from, rangeTo: q.to, projectId: q.projectId, assignee: q.assignee }));
  });
