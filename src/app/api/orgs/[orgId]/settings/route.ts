import { z } from "zod";
import { getOrgSettings, setRegistrationOpen } from "@/data/org-settings";
import { handle, readJson } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => c.tenant((await params).orgId, (s) => getOrgSettings(s)));
export const PUT = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({ registrationOpen: z.boolean() }).strict());
    return c.tenant((await params).orgId, (s) => setRegistrationOpen(s, body.registrationOpen));
  });
