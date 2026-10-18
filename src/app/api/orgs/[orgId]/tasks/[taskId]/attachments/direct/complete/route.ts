import { z } from "zod";
import { finalizeDirectUpload } from "@/data/attachments";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; taskId: string }> };
const body = z.object({ key: z.string().min(1).max(400), name: z.string().trim().min(1).max(255) }).strict();

/** Called by the browser after a direct upload: the server inspects the stored object itself before it becomes an attachment. */
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const input = await readJson(req, body);
    return c.tenant(p.orgId, (s) => finalizeDirectUpload(s, c.rt.store, uuid.parse(p.taskId), input));
  }, { status: 201 });
