import { z } from "zod";
import { createCustomRole, listRoles } from "@/data/account";
import { handle, readJson } from "@/server/api";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => ({ roles: await c.tenant((await params).orgId, (s) => listRoles(s)) }));

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(
    req,
    async (c) => {
      const body = await readJson(req, z.object({ key: z.string().min(2).max(41), name: z.string().trim().min(1).max(80), permissions: z.array(z.string()).max(100) }).strict());
      return c.tenant((await params).orgId, (s) => createCustomRole(s, body));
    },
    { status: 201 },
  );
