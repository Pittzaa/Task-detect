import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { auditLogs, customFieldDefs, customFieldValues, tasks } from "@/db/schema";
import { isValidDateOnly } from "@/domain/workflow";
import { conflict, notFound, validation } from "@/lib/errors";
import { escapeLikeValue } from "./like";
import type { TenantSession } from "./tenant";

export type FieldType = "text" | "number" | "date" | "dropdown" | "checkbox";
export type FieldDef = typeof customFieldDefs.$inferSelect;
export type FieldOption = { id: string; label: string; archived?: boolean };

const MAX_FIELDS = 50;
const MAX_OPTIONS = 50;

type Stored = { textValue?: string; numberValue?: string; dateValue?: string; optionValue?: string; boolValue?: boolean };

/**
 * Validates a client-supplied value against its definition and returns the typed column to write.
 * `existingOption` lets an unchanged value that points at an archived option stay valid.
 */
export function parseValue(def: FieldDef, input: unknown, existingOption?: string | null): Stored {
  switch (def.type) {
    case "text": {
      if (typeof input !== "string") throw validation("Expected text");
      const v = input.trim();
      if (!v || v.length > 500) throw validation("Text must be 1-500 characters");
      return { textValue: v };
    }
    case "number": {
      const n = typeof input === "number" ? input : typeof input === "string" && input.trim() !== "" ? Number(input) : NaN;
      if (!Number.isFinite(n) || Math.abs(n) > 1e12) throw validation("Expected a number");
      if (def.minValue !== null && n < Number(def.minValue)) throw validation(`Must be at least ${def.minValue}`);
      if (def.maxValue !== null && n > Number(def.maxValue)) throw validation(`Must be at most ${def.maxValue}`);
      return { numberValue: String(n) };
    }
    case "date": {
      if (typeof input !== "string" || !isValidDateOnly(input)) throw validation("Expected a date YYYY-MM-DD");
      return { dateValue: input };
    }
    case "dropdown": {
      const opt = def.options.find((o) => o.id === input);
      if (!opt || (opt.archived && input !== existingOption)) throw validation("Unknown option");
      return { optionValue: opt.id };
    }
    case "checkbox": {
      if (typeof input !== "boolean") throw validation("Expected true or false");
      return { boolValue: input };
    }
  }
}

function normalizeOptions(raw: { id?: string; label: string; archived?: boolean }[], previous: FieldOption[] = []): FieldOption[] {
  if (raw.length > MAX_OPTIONS) throw validation("Too many options");
  const out: FieldOption[] = [];
  for (const o of raw) {
    const label = o.label.trim();
    if (!label || label.length > 60) throw validation("Option labels must be 1-60 characters");
    const known = o.id ? previous.find((p) => p.id === o.id) : undefined;
    if (o.id && !known) throw validation("Unknown option id");
    out.push({ id: known?.id ?? `opt_${randomUUID().slice(0, 8)}`, label, ...(o.archived ? { archived: true } : {}) });
  }
  const live = out.filter((o) => !o.archived).map((o) => o.label.toLowerCase());
  if (new Set(live).size !== live.length) throw validation("Option labels must be unique");
  // Options may be renamed or archived but never removed, so stored values always resolve.
  for (const p of previous) if (!out.some((o) => o.id === p.id)) throw validation("Options cannot be removed; archive them instead");
  return out;
}

export interface CreateFieldInput {
  name: string;
  type: FieldType;
  options?: { label: string }[];
  minValue?: number | null;
  maxValue?: number | null;
  defaultValue?: unknown;
}

export async function createField(s: TenantSession, input: CreateFieldInput) {
  s.require("org.manage_custom_fields");
  const name = input.name.trim();
  if (!name || name.length > 60) throw validation("Name must be 1-60 characters");
  const [count] = await s.tx.select({ n: sql<number>`count(*)::int` }).from(customFieldDefs).where(and(eq(customFieldDefs.orgId, s.orgId), isNull(customFieldDefs.archivedAt)));
  if ((count?.n ?? 0) >= MAX_FIELDS) throw validation("Too many custom fields");
  if (input.type === "dropdown" && !(input.options?.length)) throw validation("A dropdown needs at least one option");
  if (input.type !== "dropdown" && input.options?.length) throw validation("Only dropdowns have options");
  if (input.type !== "number" && (input.minValue != null || input.maxValue != null)) throw validation("Only numbers have a range");
  if (input.minValue != null && input.maxValue != null && input.minValue > input.maxValue) throw validation("Minimum must not exceed maximum");

  const options = input.type === "dropdown" ? normalizeOptions(input.options!) : [];
  const draft = { name, type: input.type, options, minValue: input.minValue != null ? String(input.minValue) : null, maxValue: input.maxValue != null ? String(input.maxValue) : null } as FieldDef;
  let defaultValue: string | null = null;
  if (input.defaultValue !== undefined && input.defaultValue !== null) {
    const parsed = parseValue(draft, input.defaultValue);
    defaultValue = String(parsed.textValue ?? parsed.numberValue ?? parsed.dateValue ?? parsed.optionValue ?? parsed.boolValue);
  }
  const [row] = await s.tx
    .insert(customFieldDefs)
    .values({ orgId: s.orgId, name, type: input.type, options, minValue: draft.minValue, maxValue: draft.maxValue, defaultValue, position: (count?.n ?? 0) + 1 })
    .onConflictDoNothing()
    .returning();
  if (!row) throw conflict("A field with this name already exists");
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "custom_field.create", targetType: "custom_field", targetId: row.id, metadata: { type: input.type } });
  return row;
}

export async function updateField(
  s: TenantSession,
  fieldId: string,
  patch: { name?: string; options?: { id?: string; label: string; archived?: boolean }[]; minValue?: number | null; maxValue?: number | null; defaultValue?: unknown },
) {
  s.require("org.manage_custom_fields");
  const [def] = await s.tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.orgId, s.orgId), eq(customFieldDefs.id, fieldId), isNull(customFieldDefs.archivedAt))).for("update");
  if (!def) throw notFound();
  const next: Partial<FieldDef> = {};
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name || name.length > 60) throw validation("Name must be 1-60 characters");
    next.name = name;
  }
  if (patch.options !== undefined) {
    if (def.type !== "dropdown") throw validation("Only dropdowns have options");
    next.options = normalizeOptions(patch.options, def.options);
  }
  if (patch.minValue !== undefined || patch.maxValue !== undefined) {
    if (def.type !== "number") throw validation("Only numbers have a range");
    // Tightening a range does not rewrite existing values; they remain as entered and are re-validated on edit.
    if (patch.minValue !== undefined) next.minValue = patch.minValue === null ? null : String(patch.minValue);
    if (patch.maxValue !== undefined) next.maxValue = patch.maxValue === null ? null : String(patch.maxValue);
    const lo = next.minValue !== undefined ? next.minValue : def.minValue;
    const hi = next.maxValue !== undefined ? next.maxValue : def.maxValue;
    if (lo !== null && hi !== null && Number(lo) > Number(hi)) throw validation("Minimum must not exceed maximum");
  }
  if (patch.defaultValue !== undefined) {
    if (patch.defaultValue === null) next.defaultValue = null;
    else {
      const parsed = parseValue({ ...def, ...next } as FieldDef, patch.defaultValue);
      next.defaultValue = String(parsed.textValue ?? parsed.numberValue ?? parsed.dateValue ?? parsed.optionValue ?? parsed.boolValue);
    }
  }
  if (Object.keys(next).length === 0) return def;
  try {
    const [row] = await s.tx.update(customFieldDefs).set(next).where(eq(customFieldDefs.id, def.id)).returning();
    await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "custom_field.update", targetType: "custom_field", targetId: def.id, metadata: { fields: Object.keys(next) } });
    return row!;
  } catch (e) {
    if (String((e as { cause?: unknown }).cause ?? e).includes("custom_field_defs_name_uq")) throw conflict("A field with this name already exists");
    throw e;
  }
}

/** Archiving hides the field everywhere; stored values are kept so it can be restored later. */
export async function archiveField(s: TenantSession, fieldId: string) {
  s.require("org.manage_custom_fields");
  const res = await s.tx.update(customFieldDefs).set({ archivedAt: new Date() }).where(and(eq(customFieldDefs.orgId, s.orgId), eq(customFieldDefs.id, fieldId), isNull(customFieldDefs.archivedAt))).returning({ id: customFieldDefs.id });
  if (!res[0]) throw notFound();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "custom_field.archive", targetType: "custom_field", targetId: fieldId });
}

export async function listFields(s: TenantSession): Promise<FieldDef[]> {
  s.requireAny("org.read");
  return s.tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.orgId, s.orgId), isNull(customFieldDefs.archivedAt))).orderBy(asc(customFieldDefs.position), asc(customFieldDefs.name)).limit(MAX_FIELDS);
}

export function decodeDefault(def: FieldDef): unknown {
  if (def.defaultValue === null) return undefined;
  if (def.type === "number") return Number(def.defaultValue);
  if (def.type === "checkbox") return def.defaultValue === "true";
  return def.defaultValue;
}

export function toClient(def: FieldDef, row: typeof customFieldValues.$inferSelect | undefined): unknown {
  if (!row) return null;
  switch (def.type) {
    case "text": return row.textValue;
    case "number": return row.numberValue === null ? null : Number(row.numberValue);
    case "date": return row.dateValue;
    case "dropdown": return row.optionValue;
    case "checkbox": return row.boolValue;
  }
}

/**
 * Writes values for one task (null clears). Unknown or archived fields are rejected. Callers must
 * already have authorized the task update.
 */
export async function writeCustomValues(tx: Tx, orgId: string, taskId: string, values: Record<string, unknown>) {
  const ids = Object.keys(values);
  if (!ids.length) return;
  if (ids.length > MAX_FIELDS) throw validation("Too many fields");
  const defs = await tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.orgId, orgId), inArray(customFieldDefs.id, ids), isNull(customFieldDefs.archivedAt)));
  if (defs.length !== ids.length) throw validation("Unknown custom field");
  const existing = await tx.select().from(customFieldValues).where(and(eq(customFieldValues.orgId, orgId), eq(customFieldValues.taskId, taskId), inArray(customFieldValues.fieldId, ids)));
  for (const def of defs) {
    const input = values[def.id];
    if (input === null) {
      await tx.delete(customFieldValues).where(and(eq(customFieldValues.taskId, taskId), eq(customFieldValues.fieldId, def.id)));
      continue;
    }
    const stored = parseValue(def, input, existing.find((e) => e.fieldId === def.id)?.optionValue);
    await tx
      .insert(customFieldValues)
      .values({ orgId, taskId, fieldId: def.id, ...stored })
      .onConflictDoUpdate({
        target: [customFieldValues.taskId, customFieldValues.fieldId],
        set: { textValue: stored.textValue ?? null, numberValue: stored.numberValue ?? null, dateValue: stored.dateValue ?? null, optionValue: stored.optionValue ?? null, boolValue: stored.boolValue ?? null, updatedAt: new Date() },
      });
  }
}

/** Defaults for a new task, overridden by explicitly supplied values. */
export async function defaultsFor(tx: Tx, orgId: string): Promise<Record<string, unknown>> {
  const defs = await tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.orgId, orgId), isNull(customFieldDefs.archivedAt)));
  const out: Record<string, unknown> = {};
  for (const d of defs) {
    const v = decodeDefault(d);
    if (v === undefined) continue;
    // A default pointing at an archived option is no longer selectable, so it is not applied.
    if (d.type === "dropdown" && d.options.find((o) => o.id === v)?.archived) continue;
    out[d.id] = v;
  }
  return out;
}

/** Custom field values for several tasks, keyed task id -> field id -> client value. Archived fields are omitted. */
export async function valuesForTasks(tx: Tx, orgId: string, taskIds: string[]): Promise<Map<string, Record<string, unknown>>> {
  const out = new Map<string, Record<string, unknown>>();
  if (!taskIds.length) return out;
  const defs = await tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.orgId, orgId), isNull(customFieldDefs.archivedAt)));
  if (!defs.length) return out;
  const rows = await tx.select().from(customFieldValues).where(and(eq(customFieldValues.orgId, orgId), inArray(customFieldValues.taskId, taskIds), inArray(customFieldValues.fieldId, defs.map((d) => d.id))));
  for (const r of rows) {
    const def = defs.find((d) => d.id === r.fieldId)!;
    (out.get(r.taskId) ?? out.set(r.taskId, {}).get(r.taskId)!)[def.id] = toClient(def, r);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// filtering
// ---------------------------------------------------------------------------------------------

export type CustomFilter = { fieldId: string; op: "contains" | "eq" | "gt" | "gte" | "lt" | "lte" | "in" | "from" | "to"; value: string };
const OPS: Record<FieldType, CustomFilter["op"][]> = {
  text: ["contains", "eq"],
  number: ["eq", "gt", "gte", "lt", "lte"],
  date: ["eq", "from", "to"],
  dropdown: ["in", "eq"],
  checkbox: ["eq"],
};

/** Builds an `exists` predicate over a task's custom field value. Values are bound parameters. */
export async function customFilterConditions(tx: Tx, orgId: string, filters: CustomFilter[]): Promise<SQL[]> {
  if (!filters.length) return [];
  if (filters.length > 5) throw validation("At most 5 custom field filters");
  const defs = await tx.select().from(customFieldDefs).where(and(eq(customFieldDefs.orgId, orgId), inArray(customFieldDefs.id, filters.map((f) => f.fieldId)), isNull(customFieldDefs.archivedAt)));
  const out: SQL[] = [];
  for (const f of filters) {
    const def = defs.find((d) => d.id === f.fieldId);
    if (!def || !OPS[def.type].includes(f.op)) throw validation("Invalid custom field filter");
    const base = (cond: SQL) => sql`exists (select 1 from custom_field_values v where v.task_id = ${tasks.id} and v.org_id = ${tasks.orgId} and v.field_id = ${def.id} and ${cond})`;
    switch (def.type) {
      case "text":
        out.push(f.op === "contains" ? base(sql`v.text_value ilike ${"%" + escapeLikeValue(f.value) + "%"}`) : base(sql`lower(v.text_value) = lower(${f.value})`));
        break;
      case "number": {
        const n = Number(f.value);
        if (!Number.isFinite(n)) throw validation("Invalid number");
        const col = sql`v.number_value`;
        out.push(base(f.op === "eq" ? sql`${col} = ${n}` : f.op === "gt" ? sql`${col} > ${n}` : f.op === "gte" ? sql`${col} >= ${n}` : f.op === "lt" ? sql`${col} < ${n}` : sql`${col} <= ${n}`));
        break;
      }
      case "date": {
        if (!isValidDateOnly(f.value)) throw validation("Invalid date");
        out.push(base(f.op === "eq" ? sql`v.date_value = ${f.value}` : f.op === "from" ? sql`v.date_value >= ${f.value}` : sql`v.date_value <= ${f.value}`));
        break;
      }
      case "dropdown": {
        const ids = f.value.split(",").map((x) => x.trim()).filter(Boolean);
        if (!ids.length || ids.length > 20) throw validation("Invalid option filter");
        out.push(base(sql`v.option_value in (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
        break;
      }
      case "checkbox": {
        if (f.value !== "true" && f.value !== "false") throw validation("Invalid checkbox filter");
        const checked = base(sql`v.bool_value = true`);
        out.push(f.value === "true" ? checked : sql`not ${checked}`); // unchecked includes "never set"
        break;
      }
    }
  }
  return out;
}
