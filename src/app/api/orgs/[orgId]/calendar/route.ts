import { z } from "zod";
import { calendarStatus, disconnectCalendar } from "@/data/calendar";
import { handle, readQuery } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => ({ ...(await c.tenant((await params).orgId, (s) => calendarStatus(s))), configured: !!c.rt.google }));
export const DELETE = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const { deleteEvents } = readQuery(req, z.object({ deleteEvents: z.enum(["true", "false"]).transform((v) => v === "true").default(false) }));
    await c.tenant((await params).orgId, (s) => disconnectCalendar(s, { deleteEvents }));
    return { ok: true };
  });
