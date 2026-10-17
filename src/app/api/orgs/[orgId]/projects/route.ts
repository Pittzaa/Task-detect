import { z } from "zod";
import { createProject, listProjects } from "@/data/structure";
import { handle, readJson } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => ({ projects: await c.tenant((await params).orgId, (s) => listProjects(s)) }));
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({ name: z.string().trim().min(1).max(100) }).strict());
    return c.tenant((await params).orgId, (s) => createProject(s, body));
  }, { status: 201 });
