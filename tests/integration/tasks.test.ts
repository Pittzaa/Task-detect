import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { AppError } from "@/lib/errors";
import { withTenant } from "@/data/tenant";
import { setProjectTeams } from "@/data/structure";
import {
  addComment, addDependency, changeStatus, createLabel, createTask, deleteComment, deleteTask, editComment, getActivity, getTask,
  listComments, listLabels, listTasks, removeDependency, restoreTask, setAssignees, setTaskLabels, updateTask,
} from "@/data/tasks";
import { auditLogs, outboxEvents, taskActivity, taskDependencies, tasks } from "@/db/schema";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

async function code(p: Promise<unknown>) {
  try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; }
}

let O: Awaited<ReturnType<typeof makeOrg>>;
let X: Awaited<ReturnType<typeof makeOrg>>; // a different tenant
let P2: { id: string };
const u: Record<string, { id: string }> = {};
const as = (k: string) => ({ userId: u[k]!.id, orgId: O.org.id });
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, as(k), fn);

beforeAll(async () => {
  O = await makeOrg(c.admin, "TaskOrg");
  X = await makeOrg(c.admin, "OtherTenant");
  for (const k of ["admin", "mgr", "mem", "view", "teamMem", "outsider", "xadmin", "mem2"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.mgr!.id, { role: "manager" });
  await addMember(c.admin, O.org.id, u.mem!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.mem2!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.view!.id, { role: "viewer" });
  await addMember(c.admin, O.org.id, u.teamMem!.id, { role: "member", scope: { type: "team", id: O.team.id } });
  await addMember(c.admin, O.org.id, u.outsider!.id, {});
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
  // P1 (O.project) is shared with team T1; P2 is not.
  await run("admin", (s) => setProjectTeams(s, O.project.id, [O.team.id]));
  const [p2] = await c.admin.execute(sql`insert into projects (org_id, name) values (${O.org.id}, 'P2') returning id`).then((r) => (r as unknown as { rows: { id: string }[] }).rows);
  P2 = p2!;
});

const mk = (k: string, over: Partial<Parameters<typeof createTask>[1]> = {}) => run(k, (s) => createTask(s, { projectId: O.project.id, title: "T " + Math.random().toString(36).slice(2, 7), ...over }));

describe("create and validate", () => {
  it("creates a task with defaults, activity, audit and an outbox event holding ids only", async () => {
    const t = await mk("mem", { title: "Secret launch plan", description: "confidential text" });
    expect(t).toMatchObject({ status: "todo", priority: "medium", version: 1, completedAt: null });
    const acts = await c.admin.select().from(taskActivity).where(eq(taskActivity.taskId, t.id));
    expect(acts.map((a) => a.type)).toEqual(["created"]);
    const audits = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.targetId, t.id), eq(auditLogs.action, "task.create")));
    expect(audits).toHaveLength(1);
    const events = await c.admin.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'taskId' = ${t.id}`);
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain("Secret launch plan");
    expect(JSON.stringify(events)).not.toContain("confidential");
  });

  it("rejects blank title, impossible dates and inverted ranges", async () => {
    expect(await code(mk("mem", { title: "   " }))).toBe("VALIDATION");
    expect(await code(mk("mem", { dueDate: "2026-02-30" }))).toBe("VALIDATION");
    expect(await code(mk("mem", { startDate: "2026-03-05", dueDate: "2026-03-04" }))).toBe("VALIDATION");
    expect(await code(mk("mem", { startDate: "2026-03-05", dueDate: "2026-03-05" }))).toBe("OK");
  });

  it("database constraints back up the service rules", async () => {
    const t = await mk("mem");
    const errs = await Promise.all([
      c.admin.execute(sql`update tasks set due_date = '2020-01-01', start_date = '2021-01-01' where id = ${t.id}`).then(() => "", (e: Error) => String(e.cause ?? e)),
      c.admin.execute(sql`update tasks set status = 'done' where id = ${t.id}`).then(() => "", (e: Error) => String(e.cause ?? e)),
      c.admin.execute(sql`update tasks set parent_id = id where id = ${t.id}`).then(() => "", (e: Error) => String(e.cause ?? e)),
      c.admin.execute(sql`update tasks set title = '' where id = ${t.id}`).then(() => "", (e: Error) => String(e.cause ?? e)),
    ]);
    expect(errs[0]).toMatch(/tasks_date_range/);
    expect(errs[1]).toMatch(/tasks_completed_iff_done/);
    expect(errs[2]).toMatch(/tasks_not_own_parent|hierarchy cycle/); // trigger and CHECK both guard this
    expect(errs[3]).toMatch(/tasks_title_len/);
  });

  it("a subtask must share its parent's project (service and trigger)", async () => {
    const parent = await mk("mem");
    expect(await code(run("admin", (s) => createTask(s, { projectId: P2.id, title: "child", parentId: parent.id })))).toBe("VALIDATION");
    const child = await mk("mem", { parentId: parent.id });
    const err = await c.admin.execute(sql`update tasks set project_id = ${P2.id} where id = ${child.id}`).then(() => "", (e: Error) => String(e.cause ?? e));
    expect(err).toMatch(/same project/);
  });

  it("limits subtask depth", async () => {
    let parent = await mk("mem");
    for (let i = 0; i < 4; i++) parent = await mk("mem", { parentId: parent.id });
    expect(await code(mk("mem", { parentId: parent.id }))).toBe("VALIDATION");
  });

  it("the database refuses a hierarchy cycle", async () => {
    const a = await mk("mem");
    const b = await mk("mem", { parentId: a.id });
    const err = await c.admin.execute(sql`update tasks set parent_id = ${b.id} where id = ${a.id}`).then(() => "", (e: Error) => String(e.cause ?? e));
    expect(err).toMatch(/hierarchy cycle/);
  });
});

describe("authorization and IDOR", () => {
  it("viewer reads but cannot create/update/comment/delete", async () => {
    const t = await mk("mem");
    expect((await run("view", (s) => getTask(s, t.id))).id).toBe(t.id);
    expect(await code(mk("view"))).toBe("FORBIDDEN");
    expect(await code(run("view", (s) => updateTask(s, t.id, { version: 1, title: "x" })))).toBe("FORBIDDEN");
    expect(await code(run("view", (s) => addComment(s, t.id, { body: "hi" })))).toBe("FORBIDDEN");
    expect(await code(run("view", (s) => deleteTask(s, t.id)))).toBe("FORBIDDEN");
    expect(await code(run("view", (s) => changeStatus(s, t.id, "progress")))).toBe("FORBIDDEN");
  });

  it("a user with no access to the project gets NOT_FOUND for every operation (no existence leak)", async () => {
    const t = await mk("mem");
    for (const fn of [
      (s: never) => getTask(s, t.id), (s: never) => updateTask(s, t.id, { version: 1, title: "x" }), (s: never) => changeStatus(s, t.id, "progress"),
      (s: never) => deleteTask(s, t.id), (s: never) => addComment(s, t.id, { body: "x" }), (s: never) => getActivity(s, t.id),
      (s: never) => setAssignees(s, t.id, { primary: null, co: [] }), (s: never) => setTaskLabels(s, t.id, []), (s: never) => listComments(s, t.id),
    ]) {
      expect(await code(run("outsider", fn as never))).toBe("NOT_FOUND");
    }
    expect(await code(run("outsider", (s) => getTask(s, "00000000-0000-4000-8000-000000000000")))).toBe("NOT_FOUND");
  });

  it("cross-tenant: another org's admin cannot touch this org's task even with its id", async () => {
    const t = await mk("mem");
    const ctx = { userId: u.xadmin!.id, orgId: X.org.id };
    expect(await code(withTenant(c.app, ctx, (s) => getTask(s, t.id)))).toBe("NOT_FOUND");
    expect(await code(withTenant(c.app, ctx, (s) => changeStatus(s, t.id, "progress")))).toBe("NOT_FOUND");
    expect(await code(withTenant(c.app, ctx, (s) => deleteTask(s, t.id)))).toBe("NOT_FOUND");
    expect(await code(withTenant(c.app, { userId: u.xadmin!.id, orgId: O.org.id }, (s) => getTask(s, t.id)))).toBe("NOT_FOUND");
    expect(await code(withTenant(c.app, ctx, (s) => createTask(s, { projectId: O.project.id, title: "smuggled" })))).toBe("NOT_FOUND");
  });

  it("team-scoped member sees and edits tasks of projects their team participates in, and nothing else", async () => {
    const shared = await mk("mem", { title: "shared" });
    const other = await run("admin", (s) => createTask(s, { projectId: P2.id, title: "other" }));
    expect((await run("teamMem", (s) => getTask(s, shared.id))).id).toBe(shared.id);
    expect(await code(run("teamMem", (s) => updateTask(s, shared.id, { version: shared.version, title: "edited" })))).toBe("OK");
    expect(await code(run("teamMem", (s) => getTask(s, other.id)))).toBe("NOT_FOUND");
    const list = await run("teamMem", (s) => listTasks(s, {}));
    expect(list.items.every((t) => t.projectId === O.project.id)).toBe(true);
    expect(list.items.some((t) => t.id === other.id)).toBe(false);
    expect(await code(run("teamMem", (s) => createTask(s, { projectId: P2.id, title: "nope" })))).toBe("NOT_FOUND");
  });

  it("the detail response reports what the caller may do", async () => {
    const t = await mk("mem");
    expect((await run("view", (s) => getTask(s, t.id))).permissions).toMatchObject({ update: false, delete: false, comment: false });
    expect((await run("mgr", (s) => getTask(s, t.id))).permissions).toMatchObject({ update: true, delete: true, reopen: true });
    expect((await run("mem", (s) => getTask(s, t.id))).permissions).toMatchObject({ update: true, delete: false, reopen: false });
  });
});

describe("status workflow", () => {
  it("follows the allowed graph and records completed_at", async () => {
    const t = await mk("mem");
    expect(await code(run("mem", (s) => changeStatus(s, t.id, "done")))).toBe("VALIDATION"); // todo -> done not allowed
    const p = await run("mem", (s) => changeStatus(s, t.id, "progress"));
    expect(p.status).toBe("progress");
    const d = await run("mem", (s) => changeStatus(s, t.id, "done"));
    expect(d.completedAt).toBeInstanceOf(Date);
    expect((await run("mem", (s) => changeStatus(s, t.id, "done"))).version).toBe(d.version); // idempotent
  });

  it("reopening needs task.reopen: members cannot, managers can; cancelled is not done", async () => {
    const t = await mk("mem");
    await run("mem", (s) => changeStatus(s, t.id, "progress"));
    await run("mem", (s) => changeStatus(s, t.id, "done"));
    expect(await code(run("mem", (s) => changeStatus(s, t.id, "progress")))).toBe("FORBIDDEN");
    const reopened = await run("mgr", (s) => changeStatus(s, t.id, "progress"));
    expect(reopened).toMatchObject({ status: "progress", completedAt: null });
    const acts = await c.admin.select().from(taskActivity).where(eq(taskActivity.taskId, t.id));
    expect(acts.map((a) => a.type)).toContain("reopened");

    const x = await mk("mem");
    await run("mem", (s) => changeStatus(s, x.id, "cancelled"));
    expect(await code(run("mem", (s) => changeStatus(s, x.id, "todo")))).toBe("FORBIDDEN");
    expect(await code(run("mgr", (s) => changeStatus(s, x.id, "done")))).toBe("VALIDATION");
    expect((await run("mgr", (s) => changeStatus(s, x.id, "todo"))).status).toBe("todo");
  });

  it("a parent cannot be completed while a subtask is open", async () => {
    const parent = await mk("mem");
    const child = await mk("mem", { parentId: parent.id });
    await run("mem", (s) => changeStatus(s, parent.id, "progress"));
    expect(await code(run("mem", (s) => changeStatus(s, parent.id, "done")))).toBe("VALIDATION");
    await run("mem", (s) => changeStatus(s, child.id, "cancelled"));
    expect(await code(run("mem", (s) => changeStatus(s, parent.id, "done")))).toBe("OK");
  });

  it("concurrent conflicting status changes leave a valid final state", async () => {
    const t = await mk("mem");
    const results = await Promise.all([
      code(run("mem", (s) => changeStatus(s, t.id, "progress"))),
      code(run("mgr", (s) => changeStatus(s, t.id, "blocked"))),
      code(run("admin", (s) => changeStatus(s, t.id, "cancelled"))),
    ]);
    expect(results.every((r) => r === "OK" || r === "VALIDATION")).toBe(true);
    const [row] = await c.admin.select().from(tasks).where(eq(tasks.id, t.id));
    expect(["progress", "blocked", "cancelled"]).toContain(row!.status);
    expect(row!.version).toBeGreaterThanOrEqual(2);
  });
});

describe("dependencies", () => {
  it("blocks starting until every prerequisite is done", async () => {
    const pre = await mk("mgr");
    const dep = await mk("mgr");
    await run("mgr", (s) => addDependency(s, dep.id, pre.id));
    expect(await code(run("mem", (s) => changeStatus(s, dep.id, "progress")))).toBe("VALIDATION");
    try { await run("mem", (s) => changeStatus(s, dep.id, "progress")); } catch (e) { expect((e as AppError).data).toEqual({ blockedByCount: 1 }); }
    expect((await run("mem", (s) => listTasks(s, { projectId: O.project.id, limit: 100 }))).items.find((t) => t.id === dep.id)!.blockedByCount).toBe(1);
    expect(await code(run("mem", (s) => changeStatus(s, dep.id, "blocked")))).toBe("OK"); // non-start moves are fine
    await run("mem", (s) => changeStatus(s, pre.id, "progress"));
    await run("mem", (s) => changeStatus(s, pre.id, "done"));
    expect(await code(run("mem", (s) => changeStatus(s, dep.id, "progress")))).toBe("OK");
  });

  it("rejects self, direct, transitive and concurrently-formed cycles", async () => {
    const [a, b, d] = [await mk("mgr"), await mk("mgr"), await mk("mgr")];
    expect(await code(run("mgr", (s) => addDependency(s, a.id, a.id)))).toBe("VALIDATION");
    await run("mgr", (s) => addDependency(s, a.id, b.id)); // a depends on b
    expect(await code(run("mgr", (s) => addDependency(s, b.id, a.id)))).toBe("VALIDATION");
    await run("mgr", (s) => addDependency(s, b.id, d.id)); // b depends on d
    expect(await code(run("mgr", (s) => addDependency(s, d.id, a.id)))).toBe("VALIDATION");

    const [x, y] = [await mk("mgr"), await mk("mgr")];
    const res = await Promise.all([code(run("mgr", (s) => addDependency(s, x.id, y.id))), code(run("admin", (s) => addDependency(s, y.id, x.id)))]);
    expect(res.filter((r) => r === "OK")).toHaveLength(1);
  });

  it("the database trigger refuses a cycle even if the service is bypassed", async () => {
    const [a, b] = [await mk("mgr"), await mk("mgr")];
    await c.admin.insert(taskDependencies).values({ orgId: O.org.id, taskId: a.id, dependsOnId: b.id });
    const err = await c.admin.insert(taskDependencies).values({ orgId: O.org.id, taskId: b.id, dependsOnId: a.id }).then(() => "", (e: Error) => String(e.cause ?? e));
    expect(err).toMatch(/dependency cycle/);
  });

  it("needs task.manage_dependencies; members cannot", async () => {
    const [a, b] = [await mk("mem"), await mk("mem")];
    expect(await code(run("mem", (s) => addDependency(s, a.id, b.id)))).toBe("FORBIDDEN");
  });

  it("cancelling a prerequisite does NOT unblock; removing it or finishing it does", async () => {
    const pre = await mk("mgr"); const dep = await mk("mgr");
    await run("mgr", (s) => addDependency(s, dep.id, pre.id));
    await run("mgr", (s) => changeStatus(s, pre.id, "cancelled"));
    expect(await code(run("mgr", (s) => changeStatus(s, dep.id, "progress")))).toBe("VALIDATION");
    await run("mgr", (s) => removeDependency(s, dep.id, pre.id));
    expect(await code(run("mgr", (s) => changeStatus(s, dep.id, "progress")))).toBe("OK");
  });

  it("deleting a prerequisite unblocks its dependents; restoring re-instates the block", async () => {
    const pre = await mk("mgr"); const dep = await mk("mgr");
    await run("mgr", (s) => addDependency(s, dep.id, pre.id));
    await run("mgr", (s) => deleteTask(s, pre.id));
    expect(await code(run("mgr", (s) => changeStatus(s, dep.id, "progress")))).toBe("OK");
    await run("mgr", (s) => changeStatus(s, dep.id, "todo"));
    await run("mgr", (s) => restoreTask(s, pre.id));
    expect(await code(run("mgr", (s) => changeStatus(s, dep.id, "progress")))).toBe("VALIDATION");
  });

  it("cannot attach an unfinished prerequisite to a task that already started", async () => {
    const pre = await mk("mgr"); const dep = await mk("mgr");
    await run("mgr", (s) => changeStatus(s, dep.id, "progress"));
    expect(await code(run("mgr", (s) => addDependency(s, dep.id, pre.id)))).toBe("VALIDATION");
  });

  it("linked tasks the viewer cannot read appear as opaque placeholders", async () => {
    const hidden = await run("admin", (s) => createTask(s, { projectId: P2.id, title: "TOP SECRET" }));
    const visible = await mk("mgr");
    await run("admin", (s) => addDependency(s, visible.id, hidden.id));
    const detail = await run("teamMem", (s) => getTask(s, visible.id));
    expect(detail.prerequisites).toEqual([{ id: hidden.id, restricted: true }]);
    expect(JSON.stringify(detail)).not.toContain("TOP SECRET");
    expect(await code(run("teamMem", (s) => addDependency(s, visible.id, hidden.id)))).toBe("NOT_FOUND");
  });
});

describe("assignees", () => {
  it("supports a primary and co-assignees; validates access", async () => {
    const t = await mk("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [u.mem2!.id, u.view!.id] }));
    const d = await run("mgr", (s) => getTask(s, t.id));
    expect(d.primaryAssigneeId).toBe(u.mem!.id);
    expect(d.coAssigneeIds.sort()).toEqual([u.mem2!.id, u.view!.id].sort());
    // an org member with no role on this project, a member of another org and an unknown id are all rejected alike
    for (const bad of [u.outsider!.id, u.xadmin!.id, "00000000-0000-4000-8000-000000000000"]) {
      expect(await code(run("mgr", (s) => setAssignees(s, t.id, { primary: bad, co: [] })))).toBe("VALIDATION");
    }
    // a team-scoped member cannot be assigned to a task in a project their team doesn't participate in
    const t2 = await run("admin", (s) => createTask(s, { projectId: P2.id, title: "p2" }));
    expect(await code(run("admin", (s) => setAssignees(s, t2.id, { primary: u.teamMem!.id, co: [] })))).toBe("VALIDATION");
  });

  it("members may take or leave a task themselves but not assign others", async () => {
    const t = await mk("mem");
    expect(await code(run("mem", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] })))).toBe("OK");
    expect(await code(run("mem", (s) => setAssignees(s, t.id, { primary: u.mem2!.id, co: [] })))).toBe("FORBIDDEN");
    expect(await code(run("mem", (s) => setAssignees(s, t.id, { primary: null, co: [] })))).toBe("OK");
  });

  it("swapping who is primary and who is a co-assignee counts as assigning other people", async () => {
    const t = await mk("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem2!.id, co: [u.mem!.id] }));
    // same two people, roles exchanged: nobody is added or removed, but two other people's roles change
    expect(await code(run("mem", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [u.mem2!.id] })))).toBe("FORBIDDEN");
    // promoting a co-assignee to primary changes the old primary's role as well
    expect(await code(run("mem", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] })))).toBe("FORBIDDEN");
    // clearing the primary while keeping them as co-assignee
    expect(await code(run("mem", (s) => setAssignees(s, t.id, { primary: null, co: [u.mem2!.id, u.mem!.id] })))).toBe("FORBIDDEN");
    expect((await run("mgr", (s) => getTask(s, t.id))).primaryAssigneeId).toBe(u.mem2!.id);
    // a manager may do all of it, and doing nothing at all is still a no-op that needs no extra right
    expect(await code(run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [u.mem2!.id] })))).toBe("OK");
    expect(await code(run("mem", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [u.mem2!.id] })))).toBe("OK");
  });

  it("emits assignment events listing who was added and removed", async () => {
    const t = await mk("mgr");
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem!.id, co: [] }));
    await run("mgr", (s) => setAssignees(s, t.id, { primary: u.mem2!.id, co: [] }));
    const evs = await c.admin.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'taskId' = ${t.id} and ${outboxEvents.type} = 'task.assigned'`);
    const last = evs.at(-1)!.payload as { added: string[]; removed: string[] };
    expect(last.added).toEqual([u.mem2!.id]);
    expect(last.removed).toEqual([u.mem!.id]);
  });
});

describe("updates and concurrency", () => {
  it("optimistic locking rejects stale writes; text bodies never enter the activity log", async () => {
    const t = await mk("mem", { description: "v1 text" });
    const a = await run("mem", (s) => updateTask(s, t.id, { version: 1, description: "SENSITIVE-NEW-TEXT", priority: "high" }));
    expect(a.version).toBe(2);
    expect(await code(run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "stale" })))).toBe("CONFLICT");
    const acts = await c.admin.select().from(taskActivity).where(eq(taskActivity.taskId, t.id));
    expect(JSON.stringify(acts)).not.toContain("SENSITIVE-NEW-TEXT");
    const evs = await c.admin.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'taskId' = ${t.id} and ${outboxEvents.type} = 'task.priority_changed'`);
    expect(evs).toHaveLength(1);
  });

  it("two simultaneous edits from the same version: exactly one wins", async () => {
    const t = await mk("mem");
    const r = await Promise.all([code(run("mem", (s) => updateTask(s, t.id, { version: 1, title: "A" }))), code(run("mgr", (s) => updateTask(s, t.id, { version: 1, title: "B" })))]);
    expect(r.sort()).toEqual(["CONFLICT", "OK"]);
  });

  it("validates the merged date range against stored values", async () => {
    const t = await mk("mem", { startDate: "2026-05-10" });
    expect(await code(run("mem", (s) => updateTask(s, t.id, { version: 1, dueDate: "2026-05-09" })))).toBe("VALIDATION");
    expect(await code(run("mem", (s) => updateTask(s, t.id, { version: 1, dueDate: "2026-05-10" })))).toBe("OK");
  });
});

describe("delete and restore", () => {
  it("soft-deletes with subtasks, hides them everywhere, and restores only what was deleted together", async () => {
    const parent = await mk("mgr");
    const kid1 = await mk("mgr", { parentId: parent.id });
    const kid2 = await mk("mgr", { parentId: parent.id });
    await run("mgr", (s) => deleteTask(s, kid2.id)); // deleted earlier, separately
    const del = await run("mgr", (s) => deleteTask(s, parent.id));
    expect(del.deleted).toBe(2);
    expect(await code(run("mgr", (s) => getTask(s, parent.id)))).toBe("NOT_FOUND");
    expect((await run("mgr", (s) => listTasks(s, { projectId: O.project.id, limit: 100 }))).items.some((t) => [parent.id, kid1.id, kid2.id].includes(t.id))).toBe(false);
    expect(await code(run("mem", (s) => restoreTask(s, parent.id)))).toBe("FORBIDDEN");
    const res = await run("mgr", (s) => restoreTask(s, parent.id));
    expect(res.restored).toBe(2);
    expect((await run("mgr", (s) => getTask(s, kid1.id))).id).toBe(kid1.id);
    expect(await code(run("mgr", (s) => getTask(s, kid2.id)))).toBe("NOT_FOUND");
  });

  it("cannot restore a child while its parent is deleted", async () => {
    const parent = await mk("mgr"); const kid = await mk("mgr", { parentId: parent.id });
    await run("mgr", (s) => deleteTask(s, kid.id));
    await run("mgr", (s) => deleteTask(s, parent.id));
    expect(await code(run("mgr", (s) => restoreTask(s, kid.id)))).toBe("CONFLICT");
  });

  it("members cannot delete; deletion is audited", async () => {
    const t = await mk("mem");
    expect(await code(run("mem", (s) => deleteTask(s, t.id)))).toBe("FORBIDDEN");
    await run("admin", (s) => deleteTask(s, t.id));
    const audits = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.targetId, t.id), eq(auditLogs.action, "task.delete")));
    expect(audits).toHaveLength(1);
  });
});

describe("comments, mentions, labels", () => {
  it("mentions only people who can see the task; comment text stays out of events and activity", async () => {
    const t = await mk("mgr");
    const r = await run("mem", (s) => addComment(s, t.id, { body: "hello @outsider @mem2 PRIVATE-WORDS", mentionUserIds: [u.outsider!.id, u.mem2!.id, u.xadmin!.id, u.mem!.id] }));
    expect(r.mentioned).toBe(1); // only mem2 can see it (outsider/other-tenant dropped; self skipped)
    const evs = await c.admin.select().from(outboxEvents).where(sql`${outboxEvents.payload}->>'taskId' = ${t.id}`);
    expect(JSON.stringify(evs)).not.toContain("PRIVATE-WORDS");
    expect(JSON.stringify(await c.admin.select().from(taskActivity).where(eq(taskActivity.taskId, t.id)))).not.toContain("PRIVATE-WORDS");
    const mention = evs.find((e) => e.type === "task.mentioned")!;
    expect((mention.payload as { userIds: string[] }).userIds).toEqual([u.mem2!.id]);
  });

  it("stores comment text verbatim (rendered as plain text by the UI) and validates length", async () => {
    const t = await mk("mgr");
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    await run("mem", (s) => addComment(s, t.id, { body: evil }));
    const list = await run("view", (s) => listComments(s, t.id));
    expect(list[0]!.body).toBe(evil);
    expect(await code(run("mem", (s) => addComment(s, t.id, { body: "  " })))).toBe("VALIDATION");
    expect(await code(run("mem", (s) => addComment(s, t.id, { body: "x".repeat(10_001) })))).toBe("VALIDATION");
  });

  it("only authors edit; authors or task.delete holders remove", async () => {
    const t = await mk("mgr");
    const { id } = await run("mem", (s) => addComment(s, t.id, { body: "mine" }));
    expect(await code(run("mem2", (s) => editComment(s, id, "hijack")))).toBe("FORBIDDEN");
    expect(await code(run("mem", (s) => editComment(s, id, "edited")))).toBe("OK");
    expect(await code(run("mem2", (s) => deleteComment(s, id)))).toBe("FORBIDDEN");
    expect(await code(run("mgr", (s) => deleteComment(s, id)))).toBe("OK");
    expect(await run("mgr", (s) => listComments(s, t.id))).toHaveLength(0);
  });

  it("labels: org-scoped, unique per org case-insensitively, need label.manage", async () => {
    expect(await code(run("mem", (s) => createLabel(s, { name: "Bug" })))).toBe("FORBIDDEN");
    const bug = await run("mgr", (s) => createLabel(s, { name: "Bug", color: "#ff0000" }));
    expect(await code(run("mgr", (s) => createLabel(s, { name: "bug" })))).toBe("CONFLICT");
    expect(await code(run("mgr", (s) => createLabel(s, { name: "x", color: "red" })))).toBe("VALIDATION");
    const t = await mk("mem");
    await run("mem", (s) => setTaskLabels(s, t.id, [bug.id]));
    expect((await run("view", (s) => getTask(s, t.id))).labelIds).toEqual([bug.id]);
    expect((await run("view", (s) => listLabels(s))).map((l) => l.name)).toContain("Bug");
    // a label from another tenant cannot be attached
    const foreign = await withTenant(c.app, { userId: u.xadmin!.id, orgId: X.org.id }, (s) => createLabel(s, { name: "Foreign" }));
    expect(await code(run("mem", (s) => setTaskLabels(s, t.id, [foreign.id])))).toBe("VALIDATION");
    expect((await withTenant(c.app, { userId: u.xadmin!.id, orgId: X.org.id }, (s) => listLabels(s))).map((l) => l.name)).not.toContain("Bug");
  });
});

describe("listing, filters, pagination", () => {
  let org: Awaited<ReturnType<typeof makeOrg>>;
  let a: { id: string }; let b: { id: string };
  const ctx = () => ({ userId: a.id, orgId: org.org.id });

  beforeAll(async () => {
    org = await makeOrg(c.admin, "ListOrg");
    a = await makeUser(c.admin, "lista"); b = await makeUser(c.admin, "listb");
    await addMember(c.admin, org.org.id, a.id, { role: "orgadmin" });
    await addMember(c.admin, org.org.id, b.id, { role: "member" });
    const mk2 = (over: Partial<Parameters<typeof createTask>[1]>) => withTenant(c.app, ctx(), (s) => createTask(s, { projectId: org.project.id, title: "t", ...over }));
    const t1 = await mk2({ title: "Alpha 100%", dueDate: "2026-06-01", priority: "urgent", primaryAssigneeId: b.id });
    await mk2({ title: "Beta_test", dueDate: "2026-06-15", priority: "low" });
    await mk2({ title: "Gamma", dueDate: "2026-07-01", startDate: "2026-06-20", priority: "high", coAssigneeIds: [b.id] });
    await mk2({ title: "ไทย งาน" });
    await withTenant(c.app, ctx(), async (s) => { await changeStatus(s, t1.id, "progress"); });
    for (let i = 0; i < 5; i++) await mk2({ title: "bulk " + i });
  });

  const list = (f: Parameters<typeof listTasks>[1]) => withTenant(c.app, ctx(), (s) => listTasks(s, { projectId: org.project.id, ...f }));

  it("filters by status, priority, assignee (primary or co), date range", async () => {
    expect((await list({ status: ["progress"] })).items.map((t) => t.title)).toEqual(["Alpha 100%"]);
    expect((await list({ priority: ["low", "high"] })).items.map((t) => t.title).sort()).toEqual(["Beta_test", "Gamma"]);
    expect((await list({ assignee: b.id })).items.map((t) => t.title).sort()).toEqual(["Alpha 100%", "Gamma"]);
    expect((await list({ dueFrom: "2026-06-10", dueTo: "2026-06-30" })).items.map((t) => t.title)).toEqual(["Beta_test"]);
    expect((await list({ rangeFrom: "2026-06-18", rangeTo: "2026-06-25" })).items.map((t) => t.title)).toEqual(["Gamma"]);
  });

  it("'me' resolves server-side to the caller", async () => {
    const mine = await withTenant(c.app, { userId: b.id, orgId: org.org.id }, (s) => listTasks(s, { assignee: "me" }));
    expect(mine.items.map((t) => t.title).sort()).toEqual(["Alpha 100%", "Gamma"]);
  });

  it("overdue uses the supplied local 'today' and excludes closed tasks", async () => {
    expect((await list({ overdue: true, today: "2026-06-10" })).items.map((t) => t.title)).toEqual(["Alpha 100%"]);
    expect((await list({ overdue: true, today: "2026-12-31" })).items.map((t) => t.title).sort()).toEqual(["Alpha 100%", "Beta_test", "Gamma"]);
  });

  it("title search treats % and _ literally and handles Thai", async () => {
    expect((await list({ q: "100%" })).items.map((t) => t.title)).toEqual(["Alpha 100%"]);
    expect((await list({ q: "_" })).items.map((t) => t.title)).toEqual(["Beta_test"]);
    expect((await list({ q: "%" })).items.map((t) => t.title)).toEqual(["Alpha 100%"]);
    expect((await list({ q: "งาน" })).items.map((t) => t.title)).toEqual(["ไทย งาน"]);
  });

  it("paginates with a bounded limit and stable ordering", async () => {
    const p1 = await list({ limit: 3, sort: "title" });
    const p2 = await list({ limit: 3, offset: 3, sort: "title" });
    expect(p1.items).toHaveLength(3);
    expect(p1.hasMore).toBe(true);
    expect(new Set([...p1.items, ...p2.items].map((t) => t.id)).size).toBe(6);
    expect((await list({ limit: 10_000 })).items.length).toBeLessThanOrEqual(100);
  });

  it("members without access to the project receive nothing", async () => {
    const outsider = await makeUser(c.admin, "listout");
    await addMember(c.admin, org.org.id, outsider.id, {});
    const r = await withTenant(c.app, { userId: outsider.id, orgId: org.org.id }, (s) => listTasks(s, {}));
    expect(r.items).toEqual([]);
  });
});
