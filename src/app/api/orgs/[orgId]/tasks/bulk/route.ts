import { bulkUpdate } from "@/data/bulk";
import { handle, readJson } from "@/server/api";
import { bulkBody } from "@/server/schemas";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const body = await readJson(req, bulkBody);
    return c.tenant((await params).orgId, (s) => bulkUpdate(s, body));
  });
