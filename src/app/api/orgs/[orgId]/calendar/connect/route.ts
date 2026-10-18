import { startCalendarConnect } from "@/data/calendar";
import { AppError, notFound } from "@/lib/errors";
import { handle, UUID } from "@/server/api";

export const POST = (req: Request, { params }: { params: Promise<{ orgId: string }> }) =>
  handle(req, async (c) => {
    const { orgId } = await params;
    if (!UUID.test(orgId)) throw notFound();
    // Membership first, so a non-member gets the same 404 as everywhere else and learns nothing, not even the deployment's configuration.
    await c.tenant(orgId, async (s) => s.requireAny("task.read"));
    if (!c.rt.google || !c.rt.encryptionKeys.length) throw new AppError("CONFLICT", "Google Calendar is not configured", 409);
    return startCalendarConnect(c.db, { userId: c.user.id, orgId }, c.rt.google, { encryptionKeys: c.rt.encryptionKeys });
  });
