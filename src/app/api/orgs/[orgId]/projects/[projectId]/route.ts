import { z } from "zod";
import { deleteProject, getProject } from "@/data/structure";
import { handle, readJson } from "@/server/api";
import { confirmBody } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; projectId: string }> };
export const GET = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const { orgId, projectId } = await params;
    return c.tenant(orgId, (s) => getProject(s, z.string().uuid().parse(projectId)));
  });
export const DELETE = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const { orgId, projectId } = await params;
    const { confirm } = await readJson(req, confirmBody);
    return c.tenant(orgId, (s) => deleteProject(s, z.string().uuid().parse(projectId), confirm));
  });
