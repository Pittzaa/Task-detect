import { z } from "zod";
import { searchAll } from "@/data/search";
import { handle, readQuery } from "@/server/api";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const { q } = readQuery(req, z.object({ q: z.string().max(100) }));
    return c.tenant((await params).orgId, (s) => searchAll(s, q));
  });
