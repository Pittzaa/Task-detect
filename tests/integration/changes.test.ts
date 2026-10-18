import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { changeSignal, type ChangeSignal } from "@/data/changes";
import { addComment, addDependency, changeStatus, createLabel, createTask, deleteComment, deleteTask, editComment, removeDependency, restoreTask, setAssignees, setTaskLabels, updateTask } from "@/data/tasks";
import { withTenant } from "@/data/tenant";
import { notifications, users } from "@/db/schema";
import { AppError } from "@/lib/errors";
import { GET as route } from "@/app/api/orgs/[orgId]/changes/route";
import { Client, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());
const app = makeAuthApp(c.app);

let O: Awaited<ReturnType<typeof makeOrg>>;
let X: Awaited<ReturnType<typeof makeOrg>>;
let P2: { id: string };
const u: Record<string, { id: string }> = {};
const as = (k: string, org = O.org.id) => ({ userId: u[k]!.id, orgId: org });
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2], org?: string) => withTenant(c.app, as(k, org), fn);
const signal = (k: string, taskId?: string) => run(k, (s) => changeSignal(s, { taskId }));
async function code(p: Promise<unknown>) { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } }

/** Runs `act`, and reports which fingerprints it moved for this user. */
async function moved(who: string, act: () => Promise<unknown>, taskId?: string): Promise<(keyof ChangeSignal)[]> {
  const before = await signal(who, taskId);
  await act();
  const after = await signal(who, taskId);
  return (Object.keys(after) as (keyof ChangeSignal)[]).filter((k) => after[k] !== before[k]);
}

beforeAll(async () => {
  O = await makeOrg(c.admin, "ChangesOrg");
  X = await makeOrg(c.admin, "ChangesOther");
  for (const k of ["admin", "member", "p1only", "norole", "xadmin"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.member!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.p1only!.id, { role: "member", scope: { type: "project", id: O.project.id } });
  await addMember(c.admin, O.org.id, u.norole!.id, {});
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
  const r = (await c.admin.execute(sql`insert into projects (org_id, name) values (${O.org.id}, 'Second') returning id`)) as unknown as { rows: { id: string }[] };
  P2 = r.rows[0]!;
});

describe("what moves the 'tasks' fingerprint", () => {
  let t1 = "";
  let t2 = "";
  const tick = () => new Promise((r) => setTimeout(r, 5)); // distinct millisecond for the next write

  it("is the same when nothing changed, and is an opaque token", async () => {
    const a = await signal("admin");
    const b = await signal("admin");
    expect(b).toEqual(a);
    expect(a.tasks).toMatch(/^[0-9a-f]{16}$/);
    expect(a.notifications).toMatch(/^[0-9a-f]{16}$/);
    expect(a.comments).toBeUndefined();
  });

  it("moves for every kind of change to a visible task", async () => {
    expect(await moved("admin", async () => { t1 = (await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "One" }))).id; })).toContain("tasks");
    t2 = (await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Two" }))).id;
    const label = await run("admin", (s) => createLabel(s, { name: "sig" }));
    await tick();
    const steps: [string, () => Promise<unknown>][] = [
      ["edit", () => run("admin", (s) => updateTask(s, t1, { version: 1, title: "One!" }))],
      ["status", () => run("admin", (s) => changeStatus(s, t1, "progress"))],
      ["assignee", () => run("admin", (s) => setAssignees(s, t1, { primary: u.member!.id, co: [] }))],
      ["label", () => run("admin", (s) => setTaskLabels(s, t1, [label.id]))],
      ["dependency added", () => run("admin", (s) => addDependency(s, t2, t1))],
      ["dependency removed", () => run("admin", (s) => removeDependency(s, t2, t1))],
      ["delete", () => run("admin", (s) => deleteTask(s, t2))],
      ["restore", () => run("admin", (s) => restoreTask(s, t2))],
    ];
    for (const [name, act] of steps) {
      expect(await moved("admin", async () => { await tick(); await act(); }), name).toContain("tasks");
    }
  });

  it("does not move for things that are not tasks, nor for another organization", async () => {
    expect(await moved("admin", async () => { await tick(); await run("xadmin", (s) => createTask(s, { projectId: X.project.id, title: "elsewhere" }), X.org.id); })).toEqual([]);
    expect(await moved("admin", async () => { await tick(); await run("admin", (s) => addComment(s, t1, { body: "just a comment" })); })).not.toContain("tasks");
  });
});

describe("permission-aware: nobody learns about work they cannot read", () => {
  it("a project-scoped member's fingerprint ignores other projects and follows their own", async () => {
    const hidden = await run("admin", (s) => createTask(s, { projectId: P2.id, title: "Hidden project task" }));
    expect(await moved("p1only", async () => {
      await run("admin", (s) => updateTask(s, hidden.id, { version: 1, title: "Hidden project task, edited" }));
      await run("admin", (s) => changeStatus(s, hidden.id, "progress"));
      await run("admin", (s) => deleteTask(s, hidden.id));
      await run("admin", (s) => createTask(s, { projectId: P2.id, title: "Another hidden" }));
    })).toEqual([]);
    expect(await moved("p1only", async () => { await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Visible project task" })); })).toContain("tasks");
    // the administrator sees both
    expect(await moved("admin", async () => { await run("admin", (s) => createTask(s, { projectId: P2.id, title: "Seen by admin" })); })).toContain("tasks");
  });

  it("a member without any role gets a constant fingerprint, whatever happens", async () => {
    expect(await moved("norole", async () => { await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Not for norole" })); })).toEqual([]);
  });

  it("another tenant cannot even ask", async () => {
    expect(await code(run("xadmin", (s) => changeSignal(s), O.org.id))).toBe("NOT_FOUND");
  });
});

describe("comments and notifications fingerprints", () => {
  let task = "";
  let other = "";
  beforeAll(async () => {
    task = (await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Chatty" }))).id;
    other = (await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Quiet" }))).id;
  });

  it("comments: added, edited and deleted comments move that task's fingerprint only", async () => {
    let id = "";
    expect(await moved("member", async () => { id = (await run("member", (s) => addComment(s, task, { body: "hi" }))).id; }, task)).toEqual(["comments"]);
    await new Promise((r) => setTimeout(r, 5));
    expect(await moved("member", () => run("member", (s) => editComment(s, id, "hi again")), task)).toContain("comments");
    await new Promise((r) => setTimeout(r, 5));
    expect(await moved("member", () => run("member", (s) => deleteComment(s, id)), task)).toContain("comments");
    // a comment on another task leaves this task's comment fingerprint alone
    expect(await moved("member", async () => { await run("member", (s) => addComment(s, other, { body: "elsewhere" })); }, task)).toEqual([]);
  });

  it("comments: the fingerprint of a task one may not read is refused, not computed", async () => {
    const hidden = (await run("admin", (s) => createTask(s, { projectId: P2.id, title: "Hidden thread" }))).id;
    await run("admin", (s) => addComment(s, hidden, { body: "secret" }));
    expect(await code(signal("p1only", hidden))).toBe("NOT_FOUND");
    expect(await code(signal("norole", hidden))).toBe("NOT_FOUND");
    expect(await code(signal("admin", "00000000-0000-4000-8000-000000000000"))).toBe("NOT_FOUND");
  });

  it("notifications: only the recipient's own notifications count", async () => {
    const add = (user: string) => c.admin.insert(notifications).values({ orgId: O.org.id, userId: u[user]!.id, type: "task.assigned", taskId: task, dedupeKey: `sig-${user}-${Math.random()}` }).returning({ id: notifications.id });
    expect(await moved("member", async () => { await add("member"); })).toEqual(["notifications"]);
    expect(await moved("member", async () => { await add("admin"); })).toEqual([]);
    const [mine] = await add("member");
    await new Promise((r) => setTimeout(r, 5));
    expect(await moved("member", async () => { await c.admin.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, mine!.id)); })).toEqual(["notifications"]);
  });
});

describe("the HTTP route", () => {
  it("answers members, hides the organization from outsiders and rejects odd parameters", async () => {
    const reg = await registerAndSignIn(app, "sig");
    const [row] = await c.admin.select({ id: users.id }).from(users).where(eq(users.email, reg.email));
    const path = (q = "") => `/api/orgs/${O.org.id}/changes${q}`;
    const call = (cl: Client, q = "") => cl.route(route as never, "GET", path(q), undefined, { orgId: O.org.id });
    expect((await call(new Client(app.auth))).status).toBe(401);
    expect((await call(reg.client)).status).toBe(404); // not a member: the organization is not disclosed
    await addMember(c.admin, O.org.id, row!.id, { role: "member" });
    const ok = await call(reg.client);
    expect(ok.status).toBe(200);
    expect(Object.keys(await ok.json()).sort()).toEqual(["notifications", "tasks"]);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect((await call(reg.client, "?task=not-a-uuid")).status).toBe(422);
    expect((await call(reg.client, "?other=1")).status).toBe(422);
    expect((await call(reg.client, "?task=00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });
});
