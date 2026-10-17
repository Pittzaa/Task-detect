import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { setProjectTeams } from "@/data/structure";
import { addComment, addDependency, changeStatus, createTask, deleteTask, getTask, setAssignees } from "@/data/tasks";
import { createView, deleteView, listViews, runView, updateView } from "@/data/views";
import { searchAll } from "@/data/search";
import { bulkUpdate } from "@/data/bulk";
import { getDashboard } from "@/data/dashboard";
import { getTimeline } from "@/data/timeline";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };

let O: Awaited<ReturnType<typeof makeOrg>>; let X: Awaited<ReturnType<typeof makeOrg>>;
let P2: { id: string };
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: O.org.id }, fn);
const TODAY = "2026-06-10";

beforeAll(async () => {
  O = await makeOrg(c.admin, "ProdOrg"); X = await makeOrg(c.admin, "ProdOther");
  for (const k of ["admin", "mgr", "mem", "view", "teamMem", "teamMgr", "outsider", "xadmin"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, O.org.id, u.mem!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.view!.id, { role: "viewer" });
  await addMember(c.admin, O.org.id, u.teamMem!.id, { role: "member", scope: { type: "team", id: O.team.id } });
  await addMember(c.admin, O.org.id, u.teamMgr!.id, { role: "manager", scope: { type: "team", id: O.team.id } });
  await addMember(c.admin, O.org.id, u.outsider!.id, {});
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
  await run("admin", (s) => setProjectTeams(s, O.project.id, [O.team.id]));
  const rows = (await c.admin.execute(`insert into projects (org_id, name) values ('${O.org.id}', 'Hidden Project Zeta') returning id` as never)) as unknown as { rows: { id: string }[] };
  P2 = rows.rows[0]!;
});

const mk = (k: string, over: Partial<Parameters<typeof createTask>[1]> = {}) => run(k, (s) => createTask(s, { projectId: O.project.id, title: "t", ...over }));
const mkHidden = (title: string, over: Partial<Parameters<typeof createTask>[1]> = {}) => run("admin", (s) => createTask(s, { projectId: P2.id, title, ...over }));

describe("saved views", () => {
  it("personal views are private to their owner", async () => {
    const v = await run("mem", (s) => createView(s, { name: "Mine", kind: "list", scope: "personal", filter: { status: ["todo"] } }));
    expect((await run("mem", (s) => listViews(s))).map((x) => x.id)).toContain(v.id);
    expect((await run("mgr", (s) => listViews(s))).map((x) => x.id)).not.toContain(v.id);
    expect(await code(run("mgr", (s) => runView(s, v.id, { today: TODAY })))).toBe("NOT_FOUND");
    expect(await code(run("admin", (s) => updateView(s, v.id, { name: "hijack" })))).toBe("NOT_FOUND");
    expect(await code(run("admin", (s) => deleteView(s, v.id)))).toBe("NOT_FOUND");
  });

  it("sharing with a team needs view.share_team for that team; viewers of the team see it, others do not", async () => {
    expect(await code(run("mem", (s) => createView(s, { name: "T", kind: "list", scope: "team", teamId: O.team.id, filter: {} })))).toBe("FORBIDDEN");
    const v = await run("teamMgr", (s) => createView(s, { name: "Team board", kind: "board", scope: "team", teamId: O.team.id, filter: {} }));
    expect((await run("teamMem", (s) => listViews(s))).find((x) => x.id === v.id)).toMatchObject({ scope: "team", editable: false });
    expect((await run("teamMgr", (s) => listViews(s))).find((x) => x.id === v.id)).toMatchObject({ editable: true });
    expect((await run("outsider", (s) => listViews(s))).map((x) => x.id)).not.toContain(v.id);
    expect(await code(run("outsider", (s) => runView(s, v.id, { today: TODAY })))).toBe("NOT_FOUND");
    expect(await code(run("teamMem", (s) => deleteView(s, v.id)))).toBe("FORBIDDEN");
    expect(await code(run("teamMgr", (s) => deleteView(s, v.id)))).toBe("OK");
  });

  it("a team view for a team in another organization cannot be created", async () => {
    expect(await code(run("admin", (s) => createView(s, { name: "x", kind: "list", scope: "team", teamId: X.team.id, filter: {} })))).toBe("NOT_FOUND");
  });

  it("organization views need view.share_org and are visible to members", async () => {
    expect(await code(run("mgr", (s) => createView(s, { name: "Org", kind: "list", scope: "organization", filter: {} })))).toBe("FORBIDDEN");
    const v = await run("admin", (s) => createView(s, { name: "Org-wide", kind: "list", scope: "organization", filter: {} }));
    expect((await run("view", (s) => listViews(s))).map((x) => x.id)).toContain(v.id);
    expect(await code(run("mgr", (s) => updateView(s, v.id, { name: "x" })))).toBe("FORBIDDEN");
  });

  it("changing scope requires the right to share at the new level", async () => {
    const v = await run("teamMgr", (s) => createView(s, { name: "Promote", kind: "list", scope: "team", teamId: O.team.id, filter: {} }));
    expect(await code(run("teamMgr", (s) => updateView(s, v.id, { scope: "organization", teamId: null })))).toBe("FORBIDDEN");
    const mine = await run("mem", (s) => createView(s, { name: "Share me", kind: "list", scope: "personal", filter: {} }));
    expect(await code(run("mem", (s) => updateView(s, mine.id, { scope: "organization" })))).toBe("FORBIDDEN");
    expect(await code(run("mem", (s) => updateView(s, mine.id, { name: "Renamed" })))).toBe("OK");
  });

  it("validates filter definitions strictly", async () => {
    for (const filter of [{ status: ["bogus"] }, { projectId: "nope" }, { unknown: 1 }, { custom: Array(6).fill({ fieldId: "00000000-0000-4000-8000-000000000000", op: "eq", value: "x" }) }, { dueFrom: "2026-02-30" }]) {
      expect(await code(run("mem", (s) => createView(s, { name: "bad", kind: "list", scope: "personal", filter })))).toBe("VALIDATION");
    }
    expect(await code(run("mem", (s) => createView(s, { name: "", kind: "list", scope: "personal", filter: {} })))).toBe("VALIDATION");
    expect(await code(run("mem", (s) => createView(s, { name: "x", kind: "list", scope: "team", filter: {} })))).toBe("VALIDATION");
  });

  it("SHARING A VIEW GRANTS NO DATA: results are computed for whoever opens it", async () => {
    const secret = await mkHidden("Quarterly layoffs plan", { priority: "urgent" });
    const open = await mk("mem", { title: "Open task", priority: "urgent" });
    const v = await run("admin", (s) => createView(s, { name: "All urgent", kind: "list", scope: "organization", filter: { priority: ["urgent"] } }));
    const asAdmin = await run("admin", (s) => runView(s, v.id, { today: TODAY }));
    expect(asAdmin.items.map((t) => t.id)).toEqual(expect.arrayContaining([secret.id, open.id]));
    const asTeamMem = await run("teamMem", (s) => runView(s, v.id, { today: TODAY }));
    expect(asTeamMem.items.map((t) => t.id)).toContain(open.id);
    expect(asTeamMem.items.map((t) => t.id)).not.toContain(secret.id);
    expect(JSON.stringify(asTeamMem)).not.toContain("layoffs");
    // someone with no role anywhere cannot even see that the view exists
    expect(await code(run("outsider", (s) => runView(s, v.id, { today: TODAY })))).toBe("NOT_FOUND");
  });

  it("a view that pins a project the opener cannot read returns nothing instead of an error", async () => {
    await mkHidden("hidden one");
    const v = await run("admin", (s) => createView(s, { name: "Pinned", kind: "list", scope: "organization", filter: { projectId: P2.id } }));
    const r = await run("teamMem", (s) => runView(s, v.id, { today: TODAY }));
    expect(r.items).toEqual([]);
    expect(r.hasMore).toBe(false);
  });

  it("'me' in a shared view resolves to the opener", async () => {
    const t = await mk("mgr", { title: "For mem", primaryAssigneeId: u.mem!.id });
    const v = await run("admin", (s) => createView(s, { name: "Assigned to me", kind: "my_tasks", scope: "organization", filter: { assignee: "me" } }));
    expect((await run("mem", (s) => runView(s, v.id, { today: TODAY }))).items.map((x) => x.id)).toContain(t.id);
    expect((await run("mgr", (s) => runView(s, v.id, { today: TODAY }))).items.map((x) => x.id)).not.toContain(t.id);
  });

  it("deleted views vanish", async () => {
    const v = await run("mem", (s) => createView(s, { name: "temp", kind: "list", scope: "personal", filter: {} }));
    await run("mem", (s) => deleteView(s, v.id));
    expect(await code(run("mem", (s) => runView(s, v.id, { today: TODAY })))).toBe("NOT_FOUND");
  });

  it("views are tenant-scoped", async () => {
    const v = await withTenant(c.app, { userId: u.xadmin!.id, orgId: X.org.id }, (s) => createView(s, { name: "Other tenant", kind: "list", scope: "organization", filter: {} }));
    expect(await code(run("admin", (s) => runView(s, v.id, { today: TODAY })))).toBe("NOT_FOUND");
    expect((await run("admin", (s) => listViews(s))).map((x) => x.id)).not.toContain(v.id);
  });
});

describe("search", () => {
  it("finds only what the caller may read, in tasks, projects, teams and departments", async () => {
    await mkHidden("Zeta confidential budget");
    await mk("mem", { title: "Zeta public note", description: "contains the word zeta-keyword inside" });
    const admin = await run("admin", (s) => searchAll(s, "zeta"));
    expect(admin.tasks.map((t) => t.title).sort()).toEqual(["Zeta confidential budget", "Zeta public note"]);
    expect(admin.projects.map((p) => p.name)).toContain("Hidden Project Zeta");
    const team = await run("teamMem", (s) => searchAll(s, "zeta"));
    expect(team.tasks.map((t) => t.title)).toEqual(["Zeta public note"]);
    expect(team.projects).toEqual([]);
    const out = await run("outsider", (s) => searchAll(s, "zeta"));
    expect(out).toEqual({ tasks: [], projects: [], teams: [], departments: [] });
  });

  it("never exposes counts, totals or hidden snippets", async () => {
    await mkHidden("Omega secret", { description: "the omega password is hunter2" });
    const r = await run("teamMem", (s) => searchAll(s, "omega"));
    expect(Object.keys(r).sort()).toEqual(["departments", "projects", "tasks", "teams"]);
    expect(JSON.stringify(r)).not.toMatch(/hunter2|secret/);
  });

  it("matches description text with a snippet only for readable tasks", async () => {
    await mk("mem", { title: "Plain title", description: "long text … the needle-xyz is here … more" });
    const r = await run("mem", (s) => searchAll(s, "needle-xyz"));
    expect(r.tasks[0]!.snippet).toContain("needle-xyz");
  });

  it("team and department visibility follow scope", async () => {
    const t = await run("teamMem", (s) => searchAll(s, "Team"));
    expect(t.teams.map((x) => x.id)).toEqual([O.team.id]);
    const o = await run("outsider", (s) => searchAll(s, "Team"));
    expect(o.teams).toEqual([]);
    const other = await withTenant(c.app, { userId: u.xadmin!.id, orgId: X.org.id }, (s) => searchAll(s, "zeta"));
    expect(other.tasks).toEqual([]);
    expect(other.projects).toEqual([]);
  });

  it("excludes soft-deleted tasks, treats wildcards literally and validates length", async () => {
    const t = await mk("mgr", { title: "Delta-removed-item" });
    await run("mgr", (s) => deleteTask(s, t.id));
    expect((await run("admin", (s) => searchAll(s, "delta-removed"))).tasks).toEqual([]);
    expect((await run("admin", (s) => searchAll(s, "%%"))).tasks).toEqual([]);
    expect(await code(run("admin", (s) => searchAll(s, "a")))).toBe("VALIDATION");
    expect(await code(run("admin", (s) => searchAll(s, "x".repeat(101))))).toBe("VALIDATION");
  });
});

describe("bulk actions", () => {
  it("applies per item with partial success and safe, uniform failure codes", async () => {
    const ok = await mk("mgr"); const done = await mk("mgr");
    await run("mgr", async (s) => { await changeStatus(s, done.id, "progress"); await changeStatus(s, done.id, "done"); });
    const hidden = await mkHidden("hidden");
    const res = await run("teamMgr", (s) => bulkUpdate(s, { taskIds: [ok.id, done.id, hidden.id, "00000000-0000-4000-8000-000000000000"], action: { type: "status", status: "progress" } }));
    const by = Object.fromEntries(res.results.map((r) => [r.taskId, r]));
    expect(by[ok.id]).toMatchObject({ ok: true });
    expect(by[done.id]).toMatchObject({ ok: true }); // teamMgr holds task.reopen via the manager role: done -> progress is a reopen
    expect(by[hidden.id]).toEqual({ taskId: hidden.id, ok: false, code: "NOT_FOUND" });
    expect(by["00000000-0000-4000-8000-000000000000"]).toEqual({ taskId: "00000000-0000-4000-8000-000000000000", ok: false, code: "NOT_FOUND" }); // identical to the hidden task
    expect(res).toMatchObject({ succeeded: 2, failed: 2 });
  });

  it("authorizes every task individually", async () => {
    const t1 = await mk("mgr"); const t2 = await mk("mgr");
    const res = await run("view", (s) => bulkUpdate(s, { taskIds: [t1.id, t2.id], action: { type: "priority", priority: "high" } }));
    expect(res.results.every((r) => !r.ok && r.code === "FORBIDDEN")).toBe(true);
    expect((await run("admin", (s) => getTask(s, t1.id))).priority).toBe("medium");
  });

  it("a member can only reopen nothing: workflow rules apply per item", async () => {
    const a = await mk("mem"); const b = await mk("mem");
    await run("mem", async (s) => { await changeStatus(s, b.id, "progress"); await changeStatus(s, b.id, "done"); });
    const res = await run("mem", (s) => bulkUpdate(s, { taskIds: [a.id, b.id], action: { type: "status", status: "progress" } }));
    expect(res.results).toEqual([{ taskId: a.id, ok: true }, { taskId: b.id, ok: false, code: "FORBIDDEN" }]);
  });

  it("covers priority, due date and assignee, with assignee validation per item", async () => {
    const a = await mk("mgr"); const b = await mk("mgr", { coAssigneeIds: [u.mem!.id] });
    const hiddenForMem = await mkHidden("p2 task");
    expect((await run("mgr", (s) => bulkUpdate(s, { taskIds: [a.id, b.id], action: { type: "priority", priority: "urgent" } }))).succeeded).toBe(2);
    expect((await run("mgr", (s) => bulkUpdate(s, { taskIds: [a.id, b.id], action: { type: "dueDate", dueDate: "2026-07-01" } }))).succeeded).toBe(2);
    expect((await run("mgr", (s) => bulkUpdate(s, { taskIds: [a.id, b.id], action: { type: "assignee", userId: u.mem!.id } }))).succeeded).toBe(2);
    const d = await run("mgr", (s) => getTask(s, b.id));
    expect(d).toMatchObject({ priority: "urgent", dueDate: "2026-07-01", primaryAssigneeId: u.mem!.id });
    expect(d.coAssigneeIds).toEqual([]); // promoted from co-assignee to primary, not duplicated
    // an assignee with no access to a particular task's project is rejected for that item only
    const r = await run("admin", (s) => bulkUpdate(s, { taskIds: [a.id, hiddenForMem.id], action: { type: "assignee", userId: u.teamMem!.id } }));
    expect(r.results).toEqual([{ taskId: a.id, ok: true }, { taskId: hiddenForMem.id, ok: false, code: "VALIDATION" }]);
    expect((await run("mgr", (s) => bulkUpdate(s, { taskIds: [a.id], action: { type: "dueDate", dueDate: null } }))).succeeded).toBe(1);
  });

  it("atomic mode rolls everything back and reports per-item results", async () => {
    const ok = await mk("mgr"); const dep = await mk("mgr"); const pre = await mk("mgr");
    await run("mgr", (s) => addDependency(s, dep.id, pre.id));
    let thrown: AppError | undefined;
    try { await run("mgr", (s) => bulkUpdate(s, { taskIds: [ok.id, dep.id], action: { type: "status", status: "progress" }, atomic: true })); } catch (e) { thrown = e as AppError; }
    expect(thrown?.code).toBe("CONFLICT");
    expect(thrown?.data).toEqual({ results: [{ taskId: ok.id, ok: false, code: "ROLLED_BACK" }, { taskId: dep.id, ok: false, code: "VALIDATION" }] });
    expect((await run("mgr", (s) => getTask(s, ok.id))).status).toBe("todo");
  });

  it("de-duplicates ids, enforces the size limit and rate limit", async () => {
    const t = await mk("mgr");
    const r = await run("mgr", (s) => bulkUpdate(s, { taskIds: [t.id, t.id, t.id], action: { type: "priority", priority: "low" } }));
    expect(r.results).toHaveLength(1);
    expect(await code(run("mgr", (s) => bulkUpdate(s, { taskIds: [], action: { type: "priority", priority: "low" } })))).toBe("VALIDATION");
    const many = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    expect(await code(run("mgr", (s) => bulkUpdate(s, { taskIds: many, action: { type: "priority", priority: "low" } })))).toBe("VALIDATION");
    const spammer = await makeUser(c.admin, "bulkspam");
    await addMember(c.admin, O.org.id, spammer.id, { role: "manager" });
    const codes: string[] = [];
    for (let i = 0; i < 22; i++) codes.push(await code(withTenant(c.app, { userId: spammer.id, orgId: O.org.id }, (s) => bulkUpdate(s, { taskIds: [t.id], action: { type: "priority", priority: "low" } }))));
    expect(codes.slice(0, 20).every((x) => x === "OK")).toBe(true);
    expect(codes.slice(20)).toEqual(["RATE_LIMITED", "RATE_LIMITED"]);
  });

  it("records one audit entry per bulk call", async () => {
    const t = await mk("mgr");
    await run("mgr", (s) => bulkUpdate(s, { taskIds: [t.id], action: { type: "priority", priority: "high" } }));
    const rows = (await c.admin.execute(`select metadata from audit_logs where org_id = '${O.org.id}' and action = 'task.bulk_update' and actor_user_id = '${u.mgr!.id}'` as never)) as unknown as { rows: { metadata: { requested: number } }[] };
    expect(rows.rows.length).toBeGreaterThan(0);
  });
});

describe("dashboard and timeline", () => {
  let org: Awaited<ReturnType<typeof makeOrg>>; let a: { id: string }; let b: { id: string }; let hiddenProject: { id: string };
  const ctx = (id: string) => ({ userId: id, orgId: org.org.id });

  beforeAll(async () => {
    org = await makeOrg(c.admin, "DashOrg");
    a = await makeUser(c.admin, "dasha"); b = await makeUser(c.admin, "dashb");
    await addMember(c.admin, org.org.id, a.id, { role: "orgadmin" });
    await addMember(c.admin, org.org.id, b.id, { role: "member", scope: { type: "team", id: org.team.id } });
    const rows = (await c.admin.execute(`insert into projects (org_id, name) values ('${org.org.id}', 'Dash Hidden') returning id` as never)) as unknown as { rows: { id: string }[] };
    hiddenProject = rows.rows[0]!;
    await withTenant(c.app, ctx(a.id), (s) => setProjectTeams(s, org.project.id, [org.team.id]));
    await withTenant(c.app, ctx(a.id), async (s) => {
      const mk2 = (p: string, over: Partial<Parameters<typeof createTask>[1]>) => createTask(s, { projectId: p, title: "d", ...over });
      await mk2(org.project.id, { dueDate: "2026-06-01", priority: "high", primaryAssigneeId: b.id }); // overdue, mine for b
      await mk2(org.project.id, { dueDate: "2026-06-12" }); // due this week
      const done = await mk2(org.project.id, { dueDate: "2026-06-05" });
      await changeStatus(s, done.id, "progress"); await changeStatus(s, done.id, "done");
      await mk2(hiddenProject.id, { dueDate: "2026-06-01", priority: "urgent" });
      await mk2(hiddenProject.id, {});
    });
    // completion at 18:30Z on 06-09 is already 06-10 in Bangkok
    await c.admin.execute(`update tasks set completed_at = '2026-06-09T18:30:00Z' where org_id = '${org.org.id}' and status = 'done'` as never);
  });

  it("counts everything for an admin and only readable projects for a scoped member", async () => {
    const admin = await withTenant(c.app, ctx(a.id), (s) => getDashboard(s, { today: TODAY, timezone: "Asia/Bangkok" }));
    expect(admin.totals).toMatchObject({ open: 4, overdue: 2, dueThisWeek: 1, doneLast7Days: 1 });
    expect(admin.projects.map((p) => p.name).sort()).toEqual(["DashOrg Project", "Dash Hidden"].sort());
    const member = await withTenant(c.app, ctx(b.id), (s) => getDashboard(s, { today: TODAY, timezone: "Asia/Bangkok" }));
    expect(member.totals).toMatchObject({ open: 2, overdue: 1, mineOpen: 1, mineOverdue: 1 });
    expect(member.projects.map((p) => p.name)).toEqual(["DashOrg Project"]);
    expect(JSON.stringify(member)).not.toContain("Dash Hidden");
    expect(member.byPriority.urgent).toBe(0); // the urgent task is in the hidden project
  });

  it("assigns completions to the caller's local day", async () => {
    const bkk = await withTenant(c.app, ctx(a.id), (s) => getDashboard(s, { today: TODAY, timezone: "Asia/Bangkok" }));
    const ny = await withTenant(c.app, ctx(a.id), (s) => getDashboard(s, { today: TODAY, timezone: "America/New_York" }));
    expect(bkk.completionTrend.find((d) => d.count > 0)?.date).toBe("2026-06-10");
    expect(ny.completionTrend.find((d) => d.count > 0)?.date).toBe("2026-06-09");
    expect(bkk.completionTrend).toHaveLength(14);
  });

  it("a user with no access gets zeros", async () => {
    const lone = await makeUser(c.admin, "dashlone");
    await addMember(c.admin, org.org.id, lone.id, {});
    const d = await withTenant(c.app, ctx(lone.id), (s) => getDashboard(s, { today: TODAY, timezone: "UTC" }));
    expect(d.totals.open).toBe(0);
    expect(d.projects).toEqual([]);
  });

  it("timeline returns dependency edges only between tasks the caller can see", async () => {
    const edges = await withTenant(c.app, ctx(a.id), async (s) => {
      const t1 = await createTask(s, { projectId: org.project.id, title: "tl1", startDate: "2026-07-01", dueDate: "2026-07-05" });
      const t2 = await createTask(s, { projectId: org.project.id, title: "tl2", startDate: "2026-07-06", dueDate: "2026-07-09" });
      const h = await createTask(s, { projectId: hiddenProject.id, title: "tl-hidden", startDate: "2026-07-02", dueDate: "2026-07-03" });
      await addDependency(s, t2.id, t1.id);
      await addDependency(s, t2.id, h.id);
      return { t1, t2, h };
    });
    const asAdmin = await withTenant(c.app, ctx(a.id), (s) => getTimeline(s, { rangeFrom: "2026-07-01", rangeTo: "2026-07-31" }));
    expect(asAdmin.edges).toHaveLength(2);
    const asMember = await withTenant(c.app, ctx(b.id), (s) => getTimeline(s, { rangeFrom: "2026-07-01", rangeTo: "2026-07-31" }));
    expect(asMember.items.map((t) => t.title).sort()).toEqual(["tl1", "tl2"]);
    expect(asMember.edges).toEqual([{ taskId: edges.t2.id, prerequisiteId: edges.t1.id }]);
    expect(JSON.stringify(asMember)).not.toContain(edges.h.id);
  });

  it("the window includes tasks that merely overlap it and skips undated ones", async () => {
    await withTenant(c.app, ctx(a.id), async (s) => {
      await createTask(s, { projectId: org.project.id, title: "spans", startDate: "2026-08-25", dueDate: "2026-09-05" });
      await createTask(s, { projectId: org.project.id, title: "startOnly", startDate: "2026-09-02" });
      await createTask(s, { projectId: org.project.id, title: "undated" });
    });
    const r = await withTenant(c.app, ctx(a.id), (s) => getTimeline(s, { rangeFrom: "2026-09-01", rangeTo: "2026-09-30" }));
    expect(r.items.map((t) => t.title).sort()).toEqual(["spans", "startOnly"]);
  });
});

describe("comments and assignment still work end to end with bulk neighbours", () => {
  it("a bulk assignee change leaves comments untouched", async () => {
    const t = await mk("mgr");
    await run("mem", (s) => addComment(s, t.id, { body: "keep me" }));
    await run("mgr", (s) => bulkUpdate(s, { taskIds: [t.id], action: { type: "assignee", userId: u.mem!.id } }));
    await run("mgr", (s) => setAssignees(s, t.id, { primary: null, co: [] }));
    expect((await run("mgr", (s) => getTask(s, t.id))).primaryAssigneeId).toBeNull();
  });
});
