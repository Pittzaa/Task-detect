import { startCalendarConnect } from "@/data/calendar";
import { AppError, notFound } from "@/lib/errors";
import { handle, UUID } from "@/server/api";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const { orgId } = await params;
    if (!UUID.test(orgId)) throw notFound();
    if (!c.rt.google || !c.rt.encryptionKeys.length) throw new AppError("CONFLICT", "Google Calendar is not configured", 409);
    return startCalendarConnect(c.db, { userId: c.user.id, orgId }, c.rt.google, { encryptionKeys: c.rt.encryptionKeys });
  });
