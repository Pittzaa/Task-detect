import { deleteDepartment } from "@/data/structure";
import { handle, readJson } from "@/server/api";
import { confirmBody, uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; departmentId: string }> };
export const DELETE = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const { confirm } = await readJson(req, confirmBody);
    return c.tenant(p.orgId, (s) => deleteDepartment(s, uuid.parse(p.departmentId), confirm));
  });
