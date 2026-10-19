import { z } from "zod";
import { getOrgSettings, setAutoEmail, setEmailSchedule, setRegistrationOpen } from "@/data/org-settings";
import { handle, readJson } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => c.tenant((await params).orgId, (s) => getOrgSettings(s)));
/** Organization-wide switches: who may register, whether notification e-mails go out by themselves, and when (instant, or daily at 23:00 Thai time). Send the ones to change. */
export const PUT = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({ registrationOpen: z.boolean().optional(), autoEmail: z.boolean().optional(), emailSchedule: z.enum(["instant", "daily"]).optional() }).strict().refine((b) => b.registrationOpen !== undefined || b.autoEmail !== undefined || b.emailSchedule !== undefined, "Nothing to change"));
    return c.tenant((await params).orgId, async (s) => ({
      ...(body.registrationOpen !== undefined ? await setRegistrationOpen(s, body.registrationOpen) : {}),
      ...(body.autoEmail !== undefined ? await setAutoEmail(s, body.autoEmail) : {}),
      ...(body.emailSchedule !== undefined ? await setEmailSchedule(s, body.emailSchedule) : {}),
    }));
  });
