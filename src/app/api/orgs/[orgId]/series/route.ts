import { z } from "zod";
import { createSeries, listSeries } from "@/data/series";
import { handle, readJson, readQuery } from "@/server/api";
import { dateOnly, priority, uuid } from "@/server/schemas";

type P = { params: Promise<{ orgId: string }> };
export const GET = (req: Request, { params }: P) =>
  handle(req, async (c) => { const { projectId } = readQuery(req, z.object({ projectId: uuid })); return { series: await c.tenant((await params).orgId, (s) => listSeries(s, projectId)) }; });
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const body = await readJson(req, z.object({
      projectId: uuid, title: z.string().min(1).max(300), description: z.string().max(20_000).optional(), priority: priority.optional(),
      primaryAssigneeId: uuid.nullable().optional(), reminderDaysBefore: z.number().int().min(0).max(30).nullable().optional(),
      dueOffsetDays: z.number().int().min(0).max(365).optional(), rule: z.unknown(), startDate: dateOnly, endDate: dateOnly.nullable().optional(),
      maxOccurrences: z.number().int().min(1).max(1000).nullable().optional(),
    }).strict());
    return c.tenant((await params).orgId, (s) => createSeries(s, { ...body, timezone: c.user.timezone }));
  }, { status: 201 });
