import { z } from "zod";
import { listNotifications, markRead, unreadCount } from "@/data/notifications";
import { handle, readJson, readQuery } from "@/server/api";
import { uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string }> };
const q = z.object({ unread: z.enum(["true", "false"]).transform((v) => v === "true").optional(), limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(10_000).optional() });

export const GET = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const f = readQuery(req, q);
    return c.tenant((await params).orgId, async (s) => ({ ...(await listNotifications(s, { unreadOnly: f.unread, limit: f.limit, offset: f.offset })), unread: await unreadCount(s) }));
  });

/** Mark notifications read: `{ ids: [...] }` or `{ all: true }`. */
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.union([z.object({ all: z.literal(true) }).strict(), z.object({ ids: z.array(uuid).max(200) }).strict()]));
    const n = await c.tenant((await params).orgId, (s) => markRead(s, "all" in body ? "all" : body.ids));
    return { updated: n };
  });
