import { z } from "zod";
import { getSettings, updateSettings } from "@/data/notifications";
import { handle, readJson } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
/** The caller's own switches, plus whether e-mail is sent automatically in this organization (the page explains manual sending and disables the digests). */
export const GET = (req: Request, { params }: P) => handle(req, async (c) => c.tenant((await params).orgId, (s) => getSettings(s)));
export const PUT = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({
      settings: z.array(z.object({ channel: z.enum(["in_app", "email"]), event: z.string().max(40), enabled: z.boolean() }).strict()).max(40).optional(),
      digest: z.enum(["off", "daily", "weekly"]).optional(), quietStart: z.string().max(5).nullable().optional(), quietEnd: z.string().max(5).nullable().optional(),
    }).strict());
    await c.tenant((await params).orgId, (s) => updateSettings(s, body));
    return { ok: true };
  });
