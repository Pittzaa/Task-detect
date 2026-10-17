import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { changeStatus, getTask, setAssignees } from "@/data/tasks";
import { createSeries, deleteSeries, generateForSeriesAsCreator, generateOccurrences, listSeries, updateSeries } from "@/data/series";
import { memberships, recurrenceSeries, tasks } from "@/db/schema";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };

let O: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: O.org.id }, fn);
const TODAY = "2026-03-02"; // a Monday
const biweekly = { freq: "weekly", interval: 2, weekdays: [1] };

beforeAll(async () => {
  O = await makeOrg(c.admin, "SeriesOrg");
  for (const k of ["mgr", "mem", "view", "other"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, O.org.id, u.mem!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.view!.id, { role: "viewer" });
  await addMember(c.admin, O.org.id, u.other!.id, {});
});

const occ = (seriesId: string) => c.admin.select().from(tasks).where(and(eq(tasks.seriesId, seriesId), isNull(tasks.deletedAt))).orderBy(tasks.occurrenceDate);
const mkSeries = (over: Record<string, unknown> = {}) =>
  run("mgr", async (s) => {
    const r = await createSeries(s, { projectId: O.project.id, title: "Sprint review", rule: biweekly, startDate: TODAY, timezone: "Asia/Bangkok", ...over } as never, TODAY);
    return r;
  });

describe("creating and generating", () => {
  it("every-two-weeks series generates occurrences through the horizon with correct dates", async () => {
    // creation uses "today" in the creator's zone, so drive generation explicitly for a deterministic window
    const { series } = await mkSeries({ startDate: "2026-03-02", maxOccurrences: 100 });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    const rows = await occ(series.id);
    const dates = rows.map((r) => r.occurrenceDate);
    expect(dates.length).toBeGreaterThanOrEqual(3);
    for (let i = 1; i < dates.length; i++) expect((new Date(dates[i]!).getTime() - new Date(dates[i - 1]!).getTime()) / 86_400_000).toBe(14);
    expect(rows.every((r) => r.title === "Sprint review" && r.startDate === r.occurrenceDate && r.dueDate === r.occurrenceDate)).toBe(true);
  });

  it("re-running generation (job retry) creates nothing new", async () => {
    const { series } = await mkSeries({ title: "Idem" });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    const before = (await occ(series.id)).length;
    const again = await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    expect(again).toBe(0);
    expect((await occ(series.id)).length).toBe(before);
  });

  it("concurrent generation runs cannot create duplicates", async () => {
    const { series } = await mkSeries({ title: "Race", rule: { freq: "daily", interval: 1 } });
    const runs = await Promise.all(Array.from({ length: 4 }, () => generateForSeriesAsCreator(c.app, O.org.id, series.id, TODAY)));
    expect(runs.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(0);
    const rows = await occ(series.id);
    const dates = rows.map((r) => r.occurrenceDate);
    expect(new Set(dates).size).toBe(dates.length);
    expect(rows.length).toBe(31); // today + 30 days, daily
  });

  it("the database refuses a duplicate (series, date) pair", async () => {
    const { series } = await mkSeries({ title: "Dup" });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    const [first] = await occ(series.id);
    const err = await c.admin.insert(tasks).values({ orgId: O.org.id, projectId: O.project.id, seriesId: series.id, occurrenceDate: first!.occurrenceDate, title: "dup", createdBy: u.mgr!.id }).then(() => "", (e: Error) => String(e.cause ?? e));
    expect(err).toMatch(/tasks_series_occurrence_uq/);
  });

  it("respects the occurrence cap and end date across repeated runs", async () => {
    const { series } = await mkSeries({ title: "Capped", rule: { freq: "daily", interval: 1 }, maxOccurrences: 3 });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    await run("mgr", (s) => generateOccurrences(s, series, "2026-06-01"));
    expect((await occ(series.id)).length).toBe(3);
    const { series: ended } = await mkSeries({ title: "Ended", rule: { freq: "daily", interval: 1 }, endDate: "2026-03-05" });
    await run("mgr", (s) => generateOccurrences(s, ended, "2026-09-01"));
    expect((await occ(ended.id)).map((r) => r.occurrenceDate)).toEqual(["2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
  });

  it("validates input and permissions", async () => {
    const attempt = (k: string, over: Record<string, unknown> = {}) => code(run(k, (s) => createSeries(s, { projectId: O.project.id, title: "x", rule: biweekly, startDate: TODAY, timezone: "UTC", ...over } as never)));
    expect(await attempt("mem")).toBe("FORBIDDEN");
    expect(await attempt("view")).toBe("FORBIDDEN");
    expect(await attempt("other")).toBe("NOT_FOUND");
    expect(await attempt("mgr", { rule: { freq: "weekly", interval: 1, weekdays: [] } })).toBe("VALIDATION");
    expect(await attempt("mgr", { startDate: "2026-02-30" })).toBe("VALIDATION");
    expect(await attempt("mgr", { endDate: "2026-01-01" })).toBe("VALIDATION");
    expect(await attempt("mgr", { timezone: "Not/AZone" })).toBe("VALIDATION");
    expect(await attempt("mgr", { primaryAssigneeId: u.other!.id })).toBe("VALIDATION"); // cannot see the project
    expect(await attempt("mgr", { title: "  " })).toBe("VALIDATION");
  });
});

describe("occurrences are independent", () => {
  it("status and assignee changes on one occurrence never touch the others", async () => {
    const { series } = await mkSeries({ title: "Independent", rule: { freq: "daily", interval: 2 } });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    const [a, b, d] = await occ(series.id);
    await run("mem", (s) => changeStatus(s, a!.id, "progress"));
    await run("mgr", (s) => setAssignees(s, b!.id, { primary: u.mem!.id, co: [] }));
    const after = await occ(series.id);
    expect(after.find((r) => r.id === a!.id)!.status).toBe("progress");
    expect(after.find((r) => r.id === b!.id)!.primaryAssigneeId).toBe(u.mem!.id);
    const untouched = after.find((r) => r.id === d!.id)!;
    expect(untouched).toMatchObject({ status: "todo", primaryAssigneeId: null });
    expect((await run("mem", (s) => getTask(s, a!.id))).seriesId).toBe(series.id);
  });

  it("completing an occurrence does not generate or delete anything", async () => {
    const { series } = await mkSeries({ title: "Complete", rule: { freq: "daily", interval: 3 } });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    const before = (await occ(series.id)).length;
    const [first] = await occ(series.id);
    await run("mem", (s) => changeStatus(s, first!.id, "progress"));
    await run("mem", (s) => changeStatus(s, first!.id, "done"));
    expect((await occ(series.id)).length).toBe(before);
  });
});

describe("editing a series", () => {
  async function seeded(title: string) {
    const { series } = await mkSeries({ title, rule: { freq: "daily", interval: 1 }, maxOccurrences: 40 });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    const rows = await occ(series.id);
    await run("mem", (s) => changeStatus(s, rows[0]!.id, "progress")); // started
    await run("mem", (s) => changeStatus(s, rows[1]!.id, "cancelled"));
    return { series, rows };
  }

  it("applyToExisting=none changes only occurrences generated later", async () => {
    const { series, rows } = await seeded("Before");
    await run("mgr", (s) => updateSeries(s, series.id, { title: "After", priority: "high" }, "none", TODAY));
    const now = await occ(series.id);
    expect(now.filter((r) => r.title === "After")).toHaveLength(0);
    expect(now.length).toBe(rows.length);
  });

  it("applyToExisting=open_future updates only future todo occurrences; started and cancelled ones keep their data", async () => {
    const { series, rows } = await seeded("Template");
    const res = await run("mgr", (s) => updateSeries(s, series.id, { title: "Renamed", priority: "urgent" }, "open_future", TODAY));
    expect(res.updatedOccurrences).toBeGreaterThan(0);
    const now = await occ(series.id);
    expect(now.find((r) => r.id === rows[0]!.id)).toMatchObject({ title: "Template", status: "progress" });
    expect(now.find((r) => r.id === rows[1]!.id)).toMatchObject({ title: "Template", status: "cancelled" });
    expect(now.filter((r) => r.status === "todo").every((r) => r.title === "Renamed" && r.priority === "urgent")).toBe(true);
  });

  it("changing the schedule removes future todo occurrences that no longer fit and keeps started ones", async () => {
    const { series, rows } = await seeded("Reschedule");
    const res = await run("mgr", (s) => updateSeries(s, series.id, { rule: { freq: "weekly", interval: 1, weekdays: [1] } }, "none", TODAY));
    expect(res.removed).toBeGreaterThan(0);
    const now = await occ(series.id);
    expect(now.some((r) => r.id === rows[0]!.id)).toBe(true); // started on 2026-03-02 (a Monday) — kept regardless
    expect(now.some((r) => r.id === rows[1]!.id)).toBe(true); // cancelled, kept
    const todo = now.filter((r) => r.status === "todo");
    expect(todo.every((r) => new Date(r.occurrenceDate!).getUTCDay() === 1)).toBe(true);
    const all = await c.admin.select().from(tasks).where(and(eq(tasks.seriesId, series.id), sql`${tasks.deletedAt} is not null`));
    expect(all.length).toBe(res.removed);
  });

  it("pausing stops generation and removes future todo occurrences; resuming restores them", async () => {
    const { series } = await mkSeries({ title: "Pause", rule: { freq: "daily", interval: 1 } });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    await run("mgr", (s) => updateSeries(s, series.id, { active: false }, "none", TODAY));
    expect(await occ(series.id)).toHaveLength(0);
    const [row] = await c.admin.select().from(recurrenceSeries).where(eq(recurrenceSeries.id, series.id));
    expect(await run("mgr", (s) => generateOccurrences(s, row!, TODAY))).toBe(0);
    await run("mgr", (s) => updateSeries(s, series.id, { active: true }, "none", TODAY));
    expect((await occ(series.id)).length).toBe(31);
  });

  it("deleting a series removes only future todo occurrences", async () => {
    const { series, rows } = await seeded("Delete me");
    const res = await run("mgr", (s) => deleteSeries(s, series.id, TODAY));
    expect(res.removedOccurrences).toBeGreaterThan(0);
    const left = await occ(series.id);
    expect(left.map((r) => r.id).sort()).toEqual([rows[0]!.id, rows[1]!.id].sort());
    expect(await run("mgr", (s) => listSeries(s, O.project.id)).then((l) => l.some((x) => x.id === series.id))).toBe(false);
    expect(await code(run("mgr", (s) => updateSeries(s, series.id, { title: "x" }, "none", TODAY)))).toBe("NOT_FOUND");
  });

  it("only series.manage holders may edit; others get FORBIDDEN or NOT_FOUND", async () => {
    const { series } = await mkSeries({ title: "Perms" });
    expect(await code(run("mem", (s) => updateSeries(s, series.id, { title: "x" }, "none", TODAY)))).toBe("FORBIDDEN");
    expect(await code(run("other", (s) => updateSeries(s, series.id, { title: "x" }, "none", TODAY)))).toBe("NOT_FOUND");
    expect(await code(run("mem", (s) => deleteSeries(s, series.id, TODAY)))).toBe("FORBIDDEN");
  });
});

describe("generation re-checks access at run time", () => {
  it("an assignee who lost access gets an unassigned occurrence, not a stale grant", async () => {
    const { series } = await mkSeries({ title: "Reassign", primaryAssigneeId: u.mem!.id, rule: { freq: "daily", interval: 1 }, maxOccurrences: 5 });
    await run("mgr", (s) => generateOccurrences(s, series, TODAY));
    expect((await occ(series.id)).every((r) => r.primaryAssigneeId === u.mem!.id)).toBe(true);
    await c.admin.update(memberships).set({ status: "suspended" }).where(and(eq(memberships.userId, u.mem!.id), eq(memberships.orgId, O.org.id)));
    await c.admin.update(recurrenceSeries).set({ maxOccurrences: 10, generatedThrough: null }).where(eq(recurrenceSeries.id, series.id));
    const [fresh] = await c.admin.select().from(recurrenceSeries).where(eq(recurrenceSeries.id, series.id));
    await run("mgr", (s) => generateOccurrences(s, fresh!, TODAY));
    const rows = await occ(series.id);
    expect(rows).toHaveLength(10);
    expect(rows.slice(5).every((r) => r.primaryAssigneeId === null)).toBe(true);
    await c.admin.update(memberships).set({ status: "approved" }).where(and(eq(memberships.userId, u.mem!.id), eq(memberships.orgId, O.org.id)));
  });

  it("the job acts as the creator: if the creator is no longer approved, nothing is generated", async () => {
    const creator = await makeUser(c.admin, "gone");
    await addMember(c.admin, O.org.id, creator.id, { role: "manager" });
    const { series } = await withTenant(c.app, { userId: creator.id, orgId: O.org.id }, (s) => createSeries(s, { projectId: O.project.id, title: "Orphan", rule: { freq: "daily", interval: 1 }, startDate: "2099-01-01", timezone: "UTC" } as never, "2099-01-01"));
    await c.admin.update(memberships).set({ status: "revoked" }).where(and(eq(memberships.userId, creator.id), eq(memberships.orgId, O.org.id)));
    const before = (await occ(series.id)).length;
    expect(before).toBeGreaterThan(0); // generated while the creator was still approved
    expect(await generateForSeriesAsCreator(c.app, O.org.id, series.id, "2099-03-01")).toBe(0); // later run, creator revoked
    expect(await occ(series.id)).toHaveLength(before);
  });

  it("the horizon follows the supplied local date (zone-dependent 'today')", async () => {
    const { series } = await mkSeries({ title: "Tz", rule: { freq: "daily", interval: 1 }, startDate: "2026-01-01" });
    await run("mgr", (s) => generateOccurrences(s, series, "2026-05-10"));
    const dates = (await occ(series.id)).map((r) => r.occurrenceDate!);
    expect(dates.at(-1)).toBe("2026-06-09");
  });
});
