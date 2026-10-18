import { deleteTeam } from "@/data/structure";
import { handle } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; teamId: string }> };
export const DELETE = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; await c.tenant(p.orgId, (s) => deleteTeam(s, uuid.parse(p.teamId))); return { ok: true }; });
