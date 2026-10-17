import { listPeople } from "@/data/context";
import { handle } from "@/server/api";
import { uuid } from "@/server/schemas";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string; projectId: string }> }) =>
  handle(req, async (c) => { const p = await params; return { people: await c.tenant(p.orgId, (s) => listPeople(s, uuid.parse(p.projectId))) }; });
