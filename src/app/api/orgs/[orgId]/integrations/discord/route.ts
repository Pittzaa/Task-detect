import { z } from "zod";
import { createDestination, listDestinations } from "@/data/integrations";
import { handle, readJson } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => ({ destinations: await c.tenant((await params).orgId, (s) => listDestinations(s)) }));
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({ name: z.string().min(1).max(80), webhookUrl: z.string().max(300), teamId: uuid.nullable().optional(), projectId: uuid.nullable().optional(), events: z.array(z.string().max(40)).max(10), includeDetails: z.boolean().optional() }).strict());
    return c.tenant((await params).orgId, (s) => createDestination(s, { encryptionKeys: requireKeys(c.rt.encryptionKeys) }, body));
  }, { status: 201 });

function requireKeys(keys: string[]) {
  if (!keys.length) throw new Error("APP_ENCRYPTION_KEY is not configured");
  return keys;
}
