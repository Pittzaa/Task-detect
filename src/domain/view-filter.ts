import { z } from "zod";
import { TASK_PRIORITIES, TASK_STATUSES, isValidDateOnly } from "./workflow";

const uuid = z.string().uuid();
const date = z.string().refine(isValidDateOnly);

/** Stored definition of a saved view's filter. Re-validated every time a view is opened. */
export const viewFilterSchema = z
  .object({
    projectId: uuid.optional(),
    status: z.array(z.enum(TASK_STATUSES)).max(6).optional(),
    priority: z.array(z.enum(TASK_PRIORITIES)).max(4).optional(),
    assignee: z.union([z.literal("me"), uuid]).optional(),
    labelId: uuid.optional(),
    dueFrom: date.optional(),
    dueTo: date.optional(),
    q: z.string().max(100).optional(),
    topLevelOnly: z.boolean().optional(),
    overdue: z.boolean().optional(),
    sort: z.enum(["due", "priority", "created", "updated", "title"]).optional(),
    order: z.enum(["asc", "desc"]).optional(),
    custom: z
      .array(z.object({ fieldId: uuid, op: z.enum(["contains", "eq", "gt", "gte", "lt", "lte", "in", "from", "to"]), value: z.string().max(200) }).strict())
      .max(5)
      .optional(),
  })
  .strict();

export type ViewFilter = z.infer<typeof viewFilterSchema>;
