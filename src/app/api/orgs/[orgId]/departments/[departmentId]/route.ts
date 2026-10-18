import { deleteDepartment } from "@/data/structure";
import { handle } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; departmentId: string }> };
export const DELETE = (req: Request, { params }: P) => handle(req, async (c) => { const p = await params; return c.tenant(p.orgId, (s) => deleteDepartment(s, uuid.parse(p.departmentId))); });
