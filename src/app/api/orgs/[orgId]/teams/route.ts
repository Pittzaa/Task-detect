import { z } from "zod";
import { createTeam, listTeams } from "@/data/structure";
import { handle, readJson } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => ({ teams: await c.tenant((await params).orgId, (s) => listTeams(s)) }));
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({ departmentId: z.string().uuid(), name: z.string().trim().min(1).max(100) }).strict());
    return c.tenant((await params).orgId, (s) => createTeam(s, body));
  }, { status: 201 });
