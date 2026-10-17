import { runView } from "@/data/views";
import { todayIn } from "@/domain/time";
import { handle, readQuery } from "@/server/api";
import { pageQuery, uuid } from "@/server/schemas";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string; viewId: string }> }) =>
  handle(req, async (c) => {
    const p = await params;
    const q = readQuery(req, pageQuery);
    return c.tenant(p.orgId, (s) => runView(s, uuid.parse(p.viewId), { today: todayIn(c.user.timezone), ...q }));
  });
