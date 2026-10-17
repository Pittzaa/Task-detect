import { getActivity } from "@/data/tasks";
import { handle, readQuery } from "@/server/api";
import { pageQuery, uuid } from "@/server/schemas";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string; taskId: string }> }) =>
  handle(req, async (c) => { const p = await params; const q = readQuery(req, pageQuery); return { activity: await c.tenant(p.orgId, (s) => getActivity(s, uuid.parse(p.taskId), q)) }; });
