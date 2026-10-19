import { deleteTeam } from "@/data/structure";
import { handle, readJson } from "@/server/api";
import { confirmBody, uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; teamId: string }> };
export const DELETE = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const { confirm } = await readJson(req, confirmBody);
    await c.tenant(p.orgId, (s) => deleteTeam(s, uuid.parse(p.teamId), confirm));
    return { ok: true };
  });
