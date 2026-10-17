import { z } from "zod";
import { TASK_PRIORITIES, TASK_STATUSES, isValidDateOnly } from "@/domain/workflow";

export const uuid = z.string().uuid();
export const dateOnly = z.string().refine(isValidDateOnly, "Expected a calendar date YYYY-MM-DD");
export const status = z.enum(TASK_STATUSES);
export const priority = z.enum(TASK_PRIORITIES);

const split = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
const csvStatus = z.string().transform(split).pipe(z.array(status).max(10));
const csvPriority = z.string().transform(split).pipe(z.array(priority).max(10));

export const createTaskBody = z
  .object({
    projectId: uuid,
    title: z.string().min(1).max(300),
    description: z.string().max(20_000).optional(),
    priority: priority.optional(),
    startDate: dateOnly.nullable().optional(),
    dueDate: dateOnly.nullable().optional(),
    reminderDaysBefore: z.number().int().min(0).max(30).nullable().optional(),
    parentId: uuid.nullable().optional(),
    primaryAssigneeId: uuid.nullable().optional(),
    coAssigneeIds: z.array(uuid).max(20).optional(),
    labelIds: z.array(uuid).max(20).optional(),
    customFields: z.record(uuid, z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
  })
  .strict();

export const updateTaskBody = z
  .object({
    version: z.number().int().min(1),
    title: z.string().min(1).max(300).optional(),
    description: z.string().max(20_000).optional(),
    priority: priority.optional(),
    startDate: dateOnly.nullable().optional(),
    dueDate: dateOnly.nullable().optional(),
    reminderDaysBefore: z.number().int().min(0).max(30).nullable().optional(),
  })
  .strict();

export const taskQuery = z.object({
  projectId: uuid.optional(),
  status: csvStatus.optional(),
  priority: csvPriority.optional(),
  assignee: z.union([z.literal("me"), uuid]).optional(),
  labelId: uuid.optional(),
  dueFrom: dateOnly.optional(),
  dueTo: dateOnly.optional(),
  rangeFrom: dateOnly.optional(),
  rangeTo: dateOnly.optional(),
  q: z.string().max(100).optional(),
  parentId: uuid.optional(),
  topLevelOnly: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  overdue: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  sort: z.enum(["due", "priority", "created", "updated", "title"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).max(10_000).optional(),
});

export const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), offset: z.coerce.number().int().min(0).max(100_000).optional() });

/** `cf=<fieldId>|<op>|<value>` (repeatable) */
export function parseCustomFilters(url: string) {
  const out: { fieldId: string; op: "contains" | "eq" | "gt" | "gte" | "lt" | "lte" | "in" | "from" | "to"; value: string }[] = [];
  for (const raw of new URL(url).searchParams.getAll("cf").slice(0, 6)) {
    const [fieldId, op, ...rest] = raw.split("|");
    const parsed = z.object({ fieldId: uuid, op: z.enum(["contains", "eq", "gt", "gte", "lt", "lte", "in", "from", "to"]), value: z.string().max(200) }).parse({ fieldId, op, value: rest.join("|") });
    out.push(parsed);
  }
  return out;
}

export const customValues = z.record(uuid, z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const bulkBody = z
  .object({
    taskIds: z.array(uuid).min(1).max(100),
    atomic: z.boolean().optional(),
    action: z.discriminatedUnion("type", [
      z.object({ type: z.literal("status"), status }),
      z.object({ type: z.literal("priority"), priority }),
      z.object({ type: z.literal("assignee"), userId: uuid.nullable() }),
      z.object({ type: z.literal("dueDate"), dueDate: dateOnly.nullable() }),
    ]),
  })
  .strict();
