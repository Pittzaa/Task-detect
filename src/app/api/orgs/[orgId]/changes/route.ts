import { z } from "zod";
import { changeSignal } from "@/data/changes";
import { handle, readQuery } from "@/server/api";

const query = z.object({ task: z.string().uuid().optional() }).strict();

/** "Has anything I can see changed?" — a few hashes, polled every few seconds by open pages instead of re-running their heavy queries. */
export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const { orgId } = await params;
    const q = readQuery(req, query);
    return c.tenant(orgId, (s) => changeSignal(s, { taskId: q.task }));
  });
