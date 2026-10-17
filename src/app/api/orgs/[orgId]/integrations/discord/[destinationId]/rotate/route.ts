import { z } from "zod";
import { rotateDestination } from "@/data/integrations";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string; destinationId: string }> }) =>
  handle(req, async (c) => {
    const p = await params;
    const { webhookUrl } = await readJson(req, z.object({ webhookUrl: z.string().max(300) }).strict());
    if (!c.rt.encryptionKeys.length) throw new Error("APP_ENCRYPTION_KEY is not configured");
    await c.tenant(p.orgId, (s) => rotateDestination(s, { encryptionKeys: c.rt.encryptionKeys }, uuid.parse(p.destinationId), webhookUrl));
    return { ok: true };
  });
