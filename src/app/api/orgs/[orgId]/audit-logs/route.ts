import { z } from "zod";
import { listAuditLogs } from "@/data/context";
import { handle, readQuery } from "@/server/api";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const q = readQuery(req, z.object({ action: z.string().max(40).optional(), limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(100_000).optional() }));
    return c.tenant((await params).orgId, (s) => listAuditLogs(s, q));
  });
