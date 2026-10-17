import { getContext } from "@/data/context";
import { handle } from "@/server/api";

export const GET = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => ({ ...(await c.tenant((await params).orgId, (s) => getContext(s))), user: { id: c.user.id, name: c.user.name, email: c.user.email, locale: c.user.locale, timezone: c.user.timezone } }));
