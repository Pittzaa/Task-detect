import { and, asc, eq, gte, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import type { Db } from "@/db/client";
import { auditLogs, outboxEvents, recurrenceSeries, taskActivity, tasks } from "@/db/schema";
import { occurrences, ruleSchema, seriesBoundsSchema } from "@/domain/recurrence";
import { addDays, isValidTimeZone, todayIn } from "@/domain/time";
import type { TaskPriority } from "@/domain/workflow";
import { forbidden, notFound, validation } from "@/lib/errors";
import { projectScope } from "./scope";
import { loadPrincipal, withTenant, type TenantSession } from "./tenant";

export const GENERATION_HORIZON_DAYS = 30;

export type SeriesRow = typeof recurrenceSeries.$inferSelect;

export interface SeriesInput {
  projectId: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  primaryAssigneeId?: string | null;
  reminderDaysBefore?: number | null;
  dueOffsetDays?: number;
  rule: unknown;
  startDate: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  timezone: string;
}

function parseBounds(startDate: string, endDate?: string | null, maxOccurrences?: number | null) {
  const r = seriesBoundsSchema.safeParse({ startDate, endDate, maxOccurrences });
  if (!r.success) throw validation("Invalid series dates");
}

async function assignable(s: TenantSession, userId: string, scope: Parameters<typeof can>[2]) {
  const principal = userId === s.userId ? s.principal : await loadPrincipal(s.tx, userId, s.orgId);
  return !!principal && can(principal, "task.read", scope);
}

export async function createSeries(s: TenantSession, input: SeriesInput, todayOverride?: string) {
  const scope = await projectScope(s, input.projectId);
  if (!scope || !can(s.principal, "task.read", scope)) throw notFound();
  if (!can(s.principal, "series.manage", scope) || !can(s.principal, "task.create", scope)) throw forbidden({ permission: "series.manage" });
  const rule = ruleSchema.safeParse(input.rule);
  if (!rule.success) throw validation("Invalid recurrence rule");
  parseBounds(input.startDate, input.endDate, input.maxOccurrences);
  const title = input.title.trim();
  if (!title || title.length > 300) throw validation("val.title_required");
  if (!isValidTimeZone(input.timezone)) throw validation("Invalid time zone");
  if (input.primaryAssigneeId && !(await assignable(s, input.primaryAssigneeId, scope))) throw validation("Assignee cannot be assigned to this task");

  const [row] = await s.tx
    .insert(recurrenceSeries)
    .values({
      orgId: s.orgId, projectId: input.projectId, title, description: input.description ?? "", priority: input.priority ?? "medium",
      primaryAssigneeId: input.primaryAssigneeId ?? null, reminderDaysBefore: input.reminderDaysBefore ?? null, dueOffsetDays: input.dueOffsetDays ?? 0,
      rule: rule.data, startDate: input.startDate, endDate: input.endDate ?? null, maxOccurrences: input.maxOccurrences ?? null,
      timezone: input.timezone, createdBy: s.userId,
    })
    .returning();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "series.create", targetType: "series", targetId: row!.id });
  const generated = await generateOccurrences(s, row!, todayOverride ?? todayIn(input.timezone));
  return { series: row!, generated };
}

/**
 * Creates the missing occurrences up to today + horizon. Safe to run repeatedly or concurrently:
 * `(series_id, occurrence_date)` is unique and inserts use ON CONFLICT DO NOTHING.
 */
export async function generateOccurrences(s: TenantSession, series: SeriesRow, today: string): Promise<number> {
  if (!series.active || series.deletedAt) return 0;
  const horizon = addDays(today, GENERATION_HORIZON_DAYS);
  const rule = ruleSchema.parse(series.rule);
  // No backfill: a series starting in the past begins today. After the first run, resume from the high-water
  // mark so a gap caused by downtime is filled in.
  const from = series.generatedThrough ? addDays(series.generatedThrough, 1) : series.startDate > today ? series.startDate : today;
  const dates = from > horizon ? [] : occurrences(rule, { startDate: series.startDate, endDate: series.endDate, maxOccurrences: series.maxOccurrences, from, to: horizon });
  if (!dates.length) {
    await s.tx.update(recurrenceSeries).set({ generatedThrough: horizon }).where(eq(recurrenceSeries.id, series.id));
    return 0;
  }
  const scope = await projectScope(s, series.projectId);
  if (!scope || !can(s.principal, "task.create", scope)) return 0; // creator lost access: generate nothing
  // Re-check the assignee now; someone who lost access gets an unassigned occurrence instead of a stale grant.
  const assignee = series.primaryAssigneeId && (await assignable(s, series.primaryAssigneeId, scope)) ? series.primaryAssigneeId : null;

  let created = 0;
  for (const date of dates) {
    const inserted = await s.tx
      .insert(tasks)
      .values({
        orgId: s.orgId, projectId: series.projectId, seriesId: series.id, occurrenceDate: date, title: series.title, description: series.description,
        priority: series.priority, startDate: date, dueDate: addDays(date, series.dueOffsetDays), reminderDaysBefore: series.reminderDaysBefore,
        primaryAssigneeId: assignee, createdBy: series.createdBy, updatedBy: series.createdBy,
      })
      .onConflictDoNothing({ target: [tasks.seriesId, tasks.occurrenceDate], where: sql`${tasks.seriesId} is not null and ${tasks.deletedAt} is null` })
      .returning({ id: tasks.id });
    if (!inserted[0]) continue;
    created++;
    await s.tx.insert(taskActivity).values({ orgId: s.orgId, taskId: inserted[0].id, actorId: series.createdBy, type: "created", changes: { seriesId: series.id, occurrenceDate: date } });
    if (assignee && assignee !== series.createdBy) {
      await s.tx.insert(outboxEvents).values({ orgId: s.orgId, type: "task.assigned", payload: { taskId: inserted[0].id, actorId: series.createdBy, added: [assignee], removed: [] } });
    }
  }
  await s.tx.update(recurrenceSeries).set({ generatedThrough: horizon, updatedAt: new Date() }).where(eq(recurrenceSeries.id, series.id));
  return created;
}

/** Job entry point: acts as the series creator, so their *current* access decides what is created. */
export async function generateForSeriesAsCreator(db: Db, orgId: string, seriesId: string, today?: string): Promise<number> {
  const [peek] = await withTenantAdminRead(db, orgId, seriesId);
  if (!peek) return 0;
  try {
    return await withTenant(db, { userId: peek.createdBy, orgId }, async (s) => {
      const [row] = await s.tx.select().from(recurrenceSeries).where(and(eq(recurrenceSeries.orgId, orgId), eq(recurrenceSeries.id, seriesId))).for("update");
      if (!row) return 0;
      return generateOccurrences(s, row, today ?? todayIn(row.timezone));
    });
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code === "NOT_FOUND") return 0; // creator no longer an approved member
    throw e;
  }
}

async function withTenantAdminRead(db: Db, orgId: string, seriesId: string) {
  // Reads only the creator id, under the org context; the series row is locked and re-read inside the creator's session.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return tx.select({ createdBy: recurrenceSeries.createdBy }).from(recurrenceSeries).where(and(eq(recurrenceSeries.orgId, orgId), eq(recurrenceSeries.id, seriesId), isNull(recurrenceSeries.deletedAt)));
  });
}

export type ApplyMode = "none" | "open_future";

export interface SeriesPatch {
  title?: string;
  description?: string;
  priority?: TaskPriority;
  primaryAssigneeId?: string | null;
  reminderDaysBefore?: number | null;
  dueOffsetDays?: number;
  rule?: unknown;
  startDate?: string;
  endDate?: string | null;
  maxOccurrences?: number | null;
  active?: boolean;
}

/**
 * Edit policy:
 *  - Occurrences that are started, done, cancelled or in the past are NEVER modified or removed.
 *  - Future, still-`todo` occurrences follow the series when `applyToExisting = "open_future"` (template
 *    fields), and are removed/added when the schedule itself (rule, dates, cap) changes.
 *  - With `applyToExisting = "none"`, template edits affect only occurrences generated afterwards.
 */
export async function updateSeries(s: TenantSession, seriesId: string, patch: SeriesPatch, applyToExisting: ApplyMode, today: string) {
  const [series] = await s.tx.select().from(recurrenceSeries).where(and(eq(recurrenceSeries.orgId, s.orgId), eq(recurrenceSeries.id, seriesId), isNull(recurrenceSeries.deletedAt))).for("update");
  if (!series) throw notFound();
  const scope = await projectScope(s, series.projectId);
  if (!scope || !can(s.principal, "task.read", scope)) throw notFound();
  if (!can(s.principal, "series.manage", scope)) throw forbidden({ permission: "series.manage" });

  const next: Partial<SeriesRow> = {};
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t || t.length > 300) throw validation("val.title_required");
    next.title = t;
  }
  if (patch.description !== undefined) next.description = patch.description;
  if (patch.priority !== undefined) next.priority = patch.priority;
  if (patch.reminderDaysBefore !== undefined) next.reminderDaysBefore = patch.reminderDaysBefore;
  if (patch.dueOffsetDays !== undefined) next.dueOffsetDays = patch.dueOffsetDays;
  if (patch.primaryAssigneeId !== undefined) {
    if (patch.primaryAssigneeId && !(await assignable(s, patch.primaryAssigneeId, scope))) throw validation("Assignee cannot be assigned to this task");
    next.primaryAssigneeId = patch.primaryAssigneeId;
  }
  if (patch.rule !== undefined) {
    const r = ruleSchema.safeParse(patch.rule);
    if (!r.success) throw validation("Invalid recurrence rule");
    next.rule = r.data;
  }
  if (patch.startDate !== undefined) next.startDate = patch.startDate;
  if (patch.endDate !== undefined) next.endDate = patch.endDate;
  if (patch.maxOccurrences !== undefined) next.maxOccurrences = patch.maxOccurrences;
  if (patch.active !== undefined) next.active = patch.active;
  const merged = { ...series, ...next };
  parseBounds(merged.startDate, merged.endDate, merged.maxOccurrences);

  const scheduleChanged = ["rule", "startDate", "endDate", "maxOccurrences"].some((k) => k in next);
  const resumed = next.active === true && !series.active;
  const [updated] = await s.tx.update(recurrenceSeries).set({ ...next, ...(scheduleChanged || resumed ? { generatedThrough: null } : {}), updatedAt: new Date() }).where(eq(recurrenceSeries.id, series.id)).returning();

  let removed = 0;
  let touched = 0;
  const futureTodo = and(eq(tasks.orgId, s.orgId), eq(tasks.seriesId, series.id), eq(tasks.status, "todo"), isNull(tasks.deletedAt), gte(tasks.occurrenceDate, today));
  if (scheduleChanged || next.active === false) {
    const keep = next.active === false ? [] : occurrences(ruleSchema.parse(merged.rule), { startDate: merged.startDate, endDate: merged.endDate, maxOccurrences: merged.maxOccurrences, to: addDays(today, GENERATION_HORIZON_DAYS) });
    const stale = await s.tx.select({ id: tasks.id }).from(tasks).where(and(futureTodo, keep.length ? notInArray(tasks.occurrenceDate, keep) : undefined));
    if (stale.length) {
      const now = new Date();
      await s.tx.update(tasks).set({ deletedAt: now, deletedBy: s.userId, updatedAt: now }).where(inArray(tasks.id, stale.map((x) => x.id)));
      removed = stale.length;
    }
  }
  if (applyToExisting === "open_future") {
    const set: Partial<typeof tasks.$inferInsert> = {};
    if ("title" in next) set.title = next.title!;
    if ("description" in next) set.description = next.description!;
    if ("priority" in next) set.priority = next.priority!;
    if ("primaryAssigneeId" in next) set.primaryAssigneeId = next.primaryAssigneeId!;
    if ("reminderDaysBefore" in next) set.reminderDaysBefore = next.reminderDaysBefore!;
    if (Object.keys(set).length) {
      const res = await s.tx.update(tasks).set({ ...set, updatedAt: new Date(), updatedBy: s.userId, version: sql`${tasks.version} + 1` }).where(futureTodo).returning({ id: tasks.id });
      touched = res.length;
    }
    if ("dueOffsetDays" in next) {
      await s.tx.execute(sql`update tasks set due_date = occurrence_date + ${next.dueOffsetDays!}::int, version = version + 1, updated_at = now() where org_id = ${s.orgId} and series_id = ${series.id} and status = 'todo' and deleted_at is null and occurrence_date >= ${today}`);
    }
  }
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "series.update", targetType: "series", targetId: series.id, metadata: { fields: Object.keys(next), applyToExisting, removed } });
  const generated = updated!.active ? await generateOccurrences(s, updated!, today) : 0;
  return { series: updated!, removed, updatedOccurrences: touched, generated };
}

/** Stops the series and removes only future, not-yet-started occurrences. Everything else stays. */
export async function deleteSeries(s: TenantSession, seriesId: string, today: string) {
  const [series] = await s.tx.select().from(recurrenceSeries).where(and(eq(recurrenceSeries.orgId, s.orgId), eq(recurrenceSeries.id, seriesId), isNull(recurrenceSeries.deletedAt))).for("update");
  if (!series) throw notFound();
  const scope = await projectScope(s, series.projectId);
  if (!scope || !can(s.principal, "task.read", scope)) throw notFound();
  if (!can(s.principal, "series.manage", scope)) throw forbidden({ permission: "series.manage" });
  const now = new Date();
  await s.tx.update(recurrenceSeries).set({ active: false, deletedAt: now, updatedAt: now }).where(eq(recurrenceSeries.id, series.id));
  const res = await s.tx
    .update(tasks)
    .set({ deletedAt: now, deletedBy: s.userId, updatedAt: now })
    .where(and(eq(tasks.orgId, s.orgId), eq(tasks.seriesId, series.id), eq(tasks.status, "todo"), isNull(tasks.deletedAt), gte(tasks.occurrenceDate, today)))
    .returning({ id: tasks.id });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "series.delete", targetType: "series", targetId: series.id, metadata: { removedOccurrences: res.length } });
  return { removedOccurrences: res.length };
}

export async function listSeries(s: TenantSession, projectId: string) {
  const scope = await projectScope(s, projectId);
  if (!scope || !can(s.principal, "task.read", scope)) throw notFound();
  return s.tx
    .select({ id: recurrenceSeries.id, title: recurrenceSeries.title, description: recurrenceSeries.description, priority: recurrenceSeries.priority, primaryAssigneeId: recurrenceSeries.primaryAssigneeId, reminderDaysBefore: recurrenceSeries.reminderDaysBefore, dueOffsetDays: recurrenceSeries.dueOffsetDays, rule: recurrenceSeries.rule, startDate: recurrenceSeries.startDate, endDate: recurrenceSeries.endDate, maxOccurrences: recurrenceSeries.maxOccurrences, active: recurrenceSeries.active, timezone: recurrenceSeries.timezone, generatedThrough: recurrenceSeries.generatedThrough })
    .from(recurrenceSeries)
    .where(and(eq(recurrenceSeries.orgId, s.orgId), eq(recurrenceSeries.projectId, projectId), isNull(recurrenceSeries.deletedAt)))
    .orderBy(asc(recurrenceSeries.createdAt))
    .limit(200);
}

