import { z } from "zod";
import { deleteSeries, updateSeries } from "@/data/series";
import { todayIn } from "@/domain/time";
import { handle, readJson } from "@/server/api";
import { dateOnly, priority, uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string; seriesId: string }> };
export const PATCH = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const p = await params;
    const { applyToExisting, ...patch } = await readJson(req, z.object({
      applyToExisting: z.enum(["none", "open_future"]).default("none"),
      title: z.string().min(1).max(300).optional(), description: z.string().max(20_000).optional(), priority: priority.optional(),
      primaryAssigneeId: uuid.nullable().optional(), reminderDaysBefore: z.number().int().min(0).max(30).nullable().optional(),
      dueOffsetDays: z.number().int().min(0).max(365).optional(), rule: z.unknown().optional(), startDate: dateOnly.optional(), endDate: dateOnly.nullable().optional(),
      maxOccurrences: z.number().int().min(1).max(1000).nullable().optional(), active: z.boolean().optional(),
    }).strict());
    return c.tenant(p.orgId, (s) => updateSeries(s, uuid.parse(p.seriesId), patch, applyToExisting, todayIn(c.user.timezone)));
  });
export const DELETE = (req: Request, { params }: P) =>
  handle(req, async (c) => { const p = await params; return c.tenant(p.orgId, (s) => deleteSeries(s, uuid.parse(p.seriesId), todayIn(c.user.timezone))); });
