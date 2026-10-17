import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { archiveField, createField, listFields, updateField } from "@/data/custom-fields";
import { createTask, getTask, listTasks, setTaskCustomValues } from "@/data/tasks";
import { customFieldValues } from "@/db/schema";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };

let O: Awaited<ReturnType<typeof makeOrg>>; let X: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: O.org.id }, fn);

beforeAll(async () => {
  O = await makeOrg(c.admin, "CfOrg"); X = await makeOrg(c.admin, "CfOther");
  for (const k of ["admin", "mem", "teamMem", "xadmin"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.mem!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.teamMem!.id, { role: "member", scope: { type: "team", id: O.team.id } });
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
});

const mkTask = (over: Partial<Parameters<typeof createTask>[1]> = {}) => run("admin", (s) => createTask(s, { projectId: O.project.id, title: "cf task", ...over }));

describe("field definitions", () => {
  it("only org.manage_custom_fields may define fields; anyone with org.read somewhere may list them", async () => {
    expect(await code(run("mem", (s) => createField(s, { name: "Nope", type: "text" })))).toBe("FORBIDDEN");
    await run("admin", (s) => createField(s, { name: "Visible", type: "text" }));
    expect((await run("mem", (s) => listFields(s))).map((f) => f.name)).toContain("Visible");
    expect((await run("teamMem", (s) => listFields(s))).map((f) => f.name)).toContain("Visible"); // team-scoped member
  });

  it("validates definitions", async () => {
    expect(await code(run("admin", (s) => createField(s, { name: " ", type: "text" })))).toBe("VALIDATION");
    expect(await code(run("admin", (s) => createField(s, { name: "DD", type: "dropdown" })))).toBe("VALIDATION");
    expect(await code(run("admin", (s) => createField(s, { name: "DD2", type: "dropdown", options: [{ label: "A" }, { label: "a" }] })))).toBe("VALIDATION");
    expect(await code(run("admin", (s) => createField(s, { name: "T", type: "text", options: [{ label: "A" }] })))).toBe("VALIDATION");
    expect(await code(run("admin", (s) => createField(s, { name: "N2", type: "number", minValue: 5, maxValue: 1 })))).toBe("VALIDATION");
    await run("admin", (s) => createField(s, { name: "Unique", type: "text" }));
    expect(await code(run("admin", (s) => createField(s, { name: "unique", type: "text" })))).toBe("CONFLICT");
  });

  it("the type cannot change and options cannot be removed, only archived", async () => {
    const f = await run("admin", (s) => createField(s, { name: "Stage", type: "dropdown", options: [{ label: "Design" }, { label: "Build" }] }));
    const [design, build] = f.options;
    expect(await code(run("admin", (s) => updateField(s, f.id, { options: [{ id: design!.id, label: "Design" }] })))).toBe("VALIDATION"); // dropped Build
    const renamed = await run("admin", (s) => updateField(s, f.id, { options: [{ id: design!.id, label: "Designing" }, { id: build!.id, label: "Build", archived: true }, { label: "Ship" }] }));
    expect(renamed.options.map((o) => o.label)).toEqual(["Designing", "Build", "Ship"]);
    expect(renamed.options[0]!.id).toBe(design!.id); // ids are stable across renames
    expect(await code(run("admin", (s) => updateField(s, f.id, { options: [{ id: "opt_bogus", label: "x" }] })))).toBe("VALIDATION");
    const range = await run("admin", (s) => createField(s, { name: "Range", type: "number", minValue: 0, maxValue: 10 }));
    expect(await code(run("admin", (s) => updateField(s, range.id, { minValue: 11 })))).toBe("VALIDATION");
    expect(await code(run("admin", (s) => updateField(s, range.id, { maxValue: 20 })))).toBe("OK");
    const txt = await run("admin", (s) => createField(s, { name: "Notes", type: "text" }));
    expect(await code(run("admin", (s) => updateField(s, txt.id, { options: [{ label: "x" }] })))).toBe("VALIDATION");
    expect(await code(run("admin", (s) => updateField(s, txt.id, { minValue: 1 })))).toBe("VALIDATION");
  });
});

describe("values", () => {
  let text: { id: string }; let num: { id: string }; let date: { id: string }; let dd: { id: string; options: { id: string; label: string }[] }; let chk: { id: string };

  beforeAll(async () => {
    text = await run("admin", (s) => createField(s, { name: "Ticket", type: "text" }));
    num = await run("admin", (s) => createField(s, { name: "Cost", type: "number", minValue: 0, maxValue: 1000 }));
    date = await run("admin", (s) => createField(s, { name: "Review date", type: "date" }));
    dd = await run("admin", (s) => createField(s, { name: "Phase", type: "dropdown", options: [{ label: "Alpha" }, { label: "Beta" }] }));
    chk = await run("admin", (s) => createField(s, { name: "Approved", type: "checkbox" }));
  });

  it("validates every type on write", async () => {
    const t = await mkTask();
    const set = (values: Record<string, unknown>) => code(run("mem", (s) => setTaskCustomValues(s, t.id, values)));
    expect(await set({ [text.id]: "ABC-1", [num.id]: 12.5, [date.id]: "2026-05-01", [dd.id]: dd.options[0]!.id, [chk.id]: true })).toBe("OK");
    expect(await set({ [text.id]: 5 })).toBe("VALIDATION");
    expect(await set({ [text.id]: "x".repeat(501) })).toBe("VALIDATION");
    expect(await set({ [num.id]: -1 })).toBe("VALIDATION");
    expect(await set({ [num.id]: 1001 })).toBe("VALIDATION");
    expect(await set({ [num.id]: "abc" })).toBe("VALIDATION");
    expect(await set({ [num.id]: Number.POSITIVE_INFINITY })).toBe("VALIDATION");
    expect(await set({ [date.id]: "2026-02-30" })).toBe("VALIDATION");
    expect(await set({ [dd.id]: "opt_nope" })).toBe("VALIDATION");
    expect(await set({ [chk.id]: "yes" })).toBe("VALIDATION");
    expect(await set({ "00000000-0000-4000-8000-000000000000": "x" })).toBe("VALIDATION");
  });

  it("round-trips typed values and clears with null", async () => {
    const t = await mkTask();
    await run("mem", (s) => setTaskCustomValues(s, t.id, { [text.id]: "hello", [num.id]: "7", [date.id]: "2026-06-01", [dd.id]: dd.options[1]!.id, [chk.id]: false }));
    const d = await run("mem", (s) => getTask(s, t.id));
    expect(d.customFields).toEqual({ [text.id]: "hello", [num.id]: 7, [date.id]: "2026-06-01", [dd.id]: dd.options[1]!.id, [chk.id]: false });
    await run("mem", (s) => setTaskCustomValues(s, t.id, { [text.id]: null }));
    expect((await run("mem", (s) => getTask(s, t.id))).customFields[text.id]).toBeUndefined();
  });

  it("needs task.update on the task", async () => {
    const t = await mkTask();
    const viewer = await makeUser(c.admin, "cfview");
    await addMember(c.admin, O.org.id, viewer.id, { role: "viewer" });
    expect(await code(withTenant(c.app, { userId: viewer.id, orgId: O.org.id }, (s) => setTaskCustomValues(s, t.id, { [text.id]: "x" })))).toBe("FORBIDDEN");
  });

  it("database allows only one value column per row", async () => {
    const t = await mkTask();
    const err = await c.admin.execute(sql`insert into custom_field_values (org_id, task_id, field_id, text_value, bool_value) values (${O.org.id}, ${t.id}, ${text.id}, 'x', true)`).then(() => "", (e: Error) => String(e.cause ?? e));
    expect(err).toMatch(/custom_field_values_single/);
  });

  it("another organization's field id is rejected", async () => {
    const foreign = await withTenant(c.app, { userId: u.xadmin!.id, orgId: X.org.id }, (s) => createField(s, { name: "Foreign", type: "text" }));
    const t = await mkTask();
    expect(await code(run("mem", (s) => setTaskCustomValues(s, t.id, { [foreign.id]: "x" })))).toBe("VALIDATION");
    expect(await code(run("mem", (s) => listTasks(s, { custom: [{ fieldId: foreign.id, op: "contains", value: "x" }] })))).toBe("VALIDATION");
  });

  it("archived dropdown options stay valid for existing values but cannot be newly chosen", async () => {
    const f = await run("admin", (s) => createField(s, { name: "Lifecycle", type: "dropdown", options: [{ label: "Old" }, { label: "New" }] }));
    const [oldOpt, newOpt] = f.options;
    const t = await mkTask();
    await run("mem", (s) => setTaskCustomValues(s, t.id, { [f.id]: oldOpt!.id }));
    await run("admin", (s) => updateField(s, f.id, { options: [{ id: oldOpt!.id, label: "Old", archived: true }, { id: newOpt!.id, label: "New" }] }));
    expect(await code(run("mem", (s) => setTaskCustomValues(s, t.id, { [f.id]: oldOpt!.id })))).toBe("OK"); // unchanged value still accepted
    const t2 = await mkTask();
    expect(await code(run("mem", (s) => setTaskCustomValues(s, t2.id, { [f.id]: oldOpt!.id })))).toBe("VALIDATION");
    expect((await run("mem", (s) => getTask(s, t.id))).customFields[f.id]).toBe(oldOpt!.id);
  });

  it("archiving hides a field and its values everywhere but keeps the data", async () => {
    const f = await run("admin", (s) => createField(s, { name: "Temp", type: "text" }));
    const t = await mkTask();
    await run("mem", (s) => setTaskCustomValues(s, t.id, { [f.id]: "keep" }));
    await run("admin", (s) => archiveField(s, f.id));
    expect((await run("mem", (s) => listFields(s))).map((x) => x.id)).not.toContain(f.id);
    expect((await run("mem", (s) => getTask(s, t.id))).customFields[f.id]).toBeUndefined();
    expect(await code(run("mem", (s) => setTaskCustomValues(s, t.id, { [f.id]: "x" })))).toBe("VALIDATION");
    expect(await c.admin.select().from(customFieldValues).where(eq(customFieldValues.fieldId, f.id))).toHaveLength(1);
    // and the name can be reused
    expect(await code(run("admin", (s) => createField(s, { name: "temp", type: "text" })))).toBe("OK");
  });
});

describe("defaults", () => {
  it("applies configured defaults to new tasks and lets explicit values win", async () => {
    const f = await run("admin", (s) => createField(s, { name: "Region", type: "dropdown", options: [{ label: "TH" }, { label: "EN" }] }));
    const flag = await run("admin", (s) => createField(s, { name: "Billable", type: "checkbox", defaultValue: true }));
    const n = await run("admin", (s) => createField(s, { name: "Hours", type: "number", defaultValue: 8 }));
    await run("admin", (s) => updateField(s, f.id, { defaultValue: f.options[0]!.id }));
    const t = await mkTask();
    expect((await run("admin", (s) => getTask(s, t.id))).customFields).toMatchObject({ [f.id]: f.options[0]!.id, [flag.id]: true, [n.id]: 8 });
    const t2 = await mkTask({ customFields: { [n.id]: 2, [flag.id]: false } });
    expect((await run("admin", (s) => getTask(s, t2.id))).customFields).toMatchObject({ [n.id]: 2, [flag.id]: false });
  });

  it("rejects defaults that violate the definition", async () => {
    expect(await code(run("admin", (s) => createField(s, { name: "Bad default", type: "number", minValue: 0, maxValue: 5, defaultValue: 9 })))).toBe("VALIDATION");
    expect(await code(run("admin", (s) => createField(s, { name: "Bad default 2", type: "date", defaultValue: "nope" })))).toBe("VALIDATION");
  });
});

describe("filtering is consistent with display", () => {
  let org: Awaited<ReturnType<typeof makeOrg>>; let a: { id: string };
  let txt: { id: string }; let num: { id: string }; let dt: { id: string }; let dd: { id: string; options: { id: string }[] }; let ck: { id: string };
  const ctx = () => ({ userId: a.id, orgId: org.org.id });
  const list = (custom: Parameters<typeof listTasks>[1] extends infer F ? F extends { custom?: infer C } ? C : never : never) => withTenant(c.app, ctx(), (s) => listTasks(s, { custom })).then((r) => r.items.map((t) => t.title).sort());

  beforeAll(async () => {
    org = await makeOrg(c.admin, "CfFilter"); a = await makeUser(c.admin, "cffa");
    await addMember(c.admin, org.org.id, a.id, { role: "orgadmin" });
    await withTenant(c.app, ctx(), async (s) => {
      txt = await createField(s, { name: "Ref", type: "text" });
      num = await createField(s, { name: "Qty", type: "number" });
      dt = await createField(s, { name: "Due2", type: "date" });
      dd = await createField(s, { name: "Tier", type: "dropdown", options: [{ label: "Gold" }, { label: "Silver" }] });
      ck = await createField(s, { name: "Paid", type: "checkbox" });
      const mk = (title: string, v: Record<string, unknown>) => createTask(s, { projectId: org.project.id, title, customFields: v });
      await mk("one", { [txt.id]: "100%_done", [num.id]: 5, [dt.id]: "2026-01-10", [dd.id]: dd.options[0]!.id, [ck.id]: true });
      await mk("two", { [txt.id]: "plain", [num.id]: 15, [dt.id]: "2026-02-10", [dd.id]: dd.options[1]!.id, [ck.id]: false });
      await mk("three", {});
    });
  });

  it("text: contains (literal % and _) and eq", async () => {
    expect(await list([{ fieldId: txt.id, op: "contains", value: "100%" }])).toEqual(["one"]);
    expect(await list([{ fieldId: txt.id, op: "contains", value: "%" }])).toEqual(["one"]);
    expect(await list([{ fieldId: txt.id, op: "contains", value: "_d" }])).toEqual(["one"]);
    expect(await list([{ fieldId: txt.id, op: "eq", value: "PLAIN" }])).toEqual(["two"]);
  });
  it("number: eq / gt / gte / lt / lte", async () => {
    expect(await list([{ fieldId: num.id, op: "eq", value: "5" }])).toEqual(["one"]);
    expect(await list([{ fieldId: num.id, op: "gt", value: "5" }])).toEqual(["two"]);
    expect(await list([{ fieldId: num.id, op: "gte", value: "5" }])).toEqual(["one", "two"]);
    expect(await list([{ fieldId: num.id, op: "lt", value: "15" }])).toEqual(["one"]);
    expect(await list([{ fieldId: num.id, op: "lte", value: "15" }])).toEqual(["one", "two"]);
  });
  it("date: eq / from / to", async () => {
    expect(await list([{ fieldId: dt.id, op: "from", value: "2026-02-01" }])).toEqual(["two"]);
    expect(await list([{ fieldId: dt.id, op: "to", value: "2026-01-31" }])).toEqual(["one"]);
    expect(await list([{ fieldId: dt.id, op: "eq", value: "2026-02-10" }])).toEqual(["two"]);
  });
  it("dropdown: in", async () => {
    expect(await list([{ fieldId: dd.id, op: "in", value: dd.options[1]!.id }])).toEqual(["two"]);
    expect(await list([{ fieldId: dd.id, op: "in", value: dd.options.map((o) => o.id).join(",") }])).toEqual(["one", "two"]);
  });
  it("checkbox: unchecked includes tasks that were never set", async () => {
    expect(await list([{ fieldId: ck.id, op: "eq", value: "true" }])).toEqual(["one"]);
    expect(await list([{ fieldId: ck.id, op: "eq", value: "false" }])).toEqual(["three", "two"]);
  });
  it("combines filters with AND and rejects invalid combinations", async () => {
    expect(await list([{ fieldId: num.id, op: "gte", value: "5" }, { fieldId: ck.id, op: "eq", value: "true" }])).toEqual(["one"]);
    expect(await code(withTenant(c.app, ctx(), (s) => listTasks(s, { custom: [{ fieldId: num.id, op: "contains", value: "1" }] })))).toBe("VALIDATION");
    expect(await code(withTenant(c.app, ctx(), (s) => listTasks(s, { custom: [{ fieldId: dt.id, op: "eq", value: "garbage" }] })))).toBe("VALIDATION");
    expect(await code(withTenant(c.app, ctx(), (s) => listTasks(s, { custom: Array(6).fill({ fieldId: num.id, op: "eq", value: "1" }) })))).toBe("VALIDATION");
  });
  it("list rows carry the same values the detail view shows", async () => {
    const rows = (await withTenant(c.app, ctx(), (s) => listTasks(s, {}))).items;
    const one = rows.find((r) => r.title === "one")!;
    const detail = await withTenant(c.app, ctx(), (s) => getTask(s, one.id));
    expect(one.customFields).toEqual(detail.customFields);
  });
  it("filter values are bound parameters (SQL metacharacters are inert)", async () => {
    expect(await list([{ fieldId: txt.id, op: "contains", value: "'; drop table tasks; --" }])).toEqual([]);
    expect((await c.admin.execute(sql`select count(*)::int as n from tasks`) as unknown as { rows: { n: number }[] }).rows[0]!.n).toBeGreaterThan(0);
  });
});
