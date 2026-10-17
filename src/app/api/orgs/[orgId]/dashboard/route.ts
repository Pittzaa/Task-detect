import { z } from "zod";
import { getDashboard } from "@/data/dashboard";
import { todayIn } from "@/domain/time";
import { handle, readQuery } from "@/server/api";
import { uuid } from "@/server/schemas";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const { projectId } = readQuery(req, z.object({ projectId: uuid.optional() }));
    return c.tenant((await params).orgId, (s) => getDashboard(s, { today: todayIn(c.user.timezone), timezone: c.user.timezone, projectId }));
  });
