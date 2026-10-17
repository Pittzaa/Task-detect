import { z } from "zod";
import { deleteCustomRole, updateCustomRolePermissions } from "@/data/account";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; roleId: string }> };
export const PATCH = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const { permissions } = await readJson(req, z.object({ permissions: z.array(z.string().max(60)).max(100) }).strict());
    await c.tenant(p.orgId, (s) => updateCustomRolePermissions(s, uuid.parse(p.roleId), permissions));
    return { ok: true };
  });
export const DELETE = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; await c.tenant(p.orgId, (s) => deleteCustomRole(s, uuid.parse(p.roleId))); return { ok: true }; });
