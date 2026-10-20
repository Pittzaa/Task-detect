import { z } from "zod";
import { getOrgSettings, setAppName, setAutoEmail, setEmailSchedule, setOrgName, setRegistrationOpen } from "@/data/org-settings";
import { forgetBrand } from "@/server/brand";
import { handle, readJson } from "@/server/api";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) => handle(req, async (c) => c.tenant((await params).orgId, (s) => getOrgSettings(s)));
/**
 * Organization-wide settings: who may register, whether notification e-mails go out by themselves, when (instant, or daily at 23:00 Thai time), the name
 * of the product (`appName`, null: the default) and the name of the organization itself (`name`, the heading of the left menu). Send the ones to change.
 */
export const PUT = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({ registrationOpen: z.boolean().optional(), autoEmail: z.boolean().optional(), emailSchedule: z.enum(["instant", "daily"]).optional(), appName: z.union([z.string().max(200), z.null()]).optional(), name: z.string().max(400).optional() }).strict().refine((b) => b.registrationOpen !== undefined || b.autoEmail !== undefined || b.emailSchedule !== undefined || b.appName !== undefined || b.name !== undefined, "Nothing to change"));
    const out = await c.tenant((await params).orgId, async (s) => ({
      ...(body.registrationOpen !== undefined ? await setRegistrationOpen(s, body.registrationOpen) : {}),
      ...(body.autoEmail !== undefined ? await setAutoEmail(s, body.autoEmail) : {}),
      ...(body.emailSchedule !== undefined ? await setEmailSchedule(s, body.emailSchedule) : {}),
      ...(body.appName !== undefined ? await setAppName(s, body.appName) : {}),
      ...(body.name !== undefined ? await setOrgName(s, body.name) : {}),
    }));
    if (body.appName !== undefined) forgetBrand(); // the next page on this instance shows the new name at once
    return out;
  });
