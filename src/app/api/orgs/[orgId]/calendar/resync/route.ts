import { requestResync } from "@/data/calendar";
import { handle } from "@/server/api";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => { await c.tenant((await params).orgId, (s) => requestResync(s)); return { ok: true }; }, { status: 202 });
