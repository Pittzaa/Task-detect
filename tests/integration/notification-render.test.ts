import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { listNotifications } from "@/data/notifications";
import { createTask } from "@/data/tasks";
import { withTenant } from "@/data/tenant";
import { notifications, tasks } from "@/db/schema";
import { renderNotifications } from "@/jobs/notify";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

let O: Awaited<ReturnType<typeof makeOrg>>;
let P2: { id: string };
const u: Record<string, { id: string }> = {};
const ids: Record<string, string> = {};
const as = (k: string) => ({ userId: u[k]!.id, orgId: O.org.id });

beforeAll(async () => {
  O = await makeOrg(c.admin, "RenderOrg");
  for (const k of ["admin", "p1only", "actor"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.actor!.id, { role: "member" });
  await addMember(c.admin, O.org.id, u.p1only!.id, { role: "member", scope: { type: "project", id: O.project.id } });
  P2 = ((await c.admin.execute(sql`insert into projects (org_id, name) values (${O.org.id}, 'Other') returning id`)) as unknown as { rows: { id: string }[] }).rows[0]!;
  const mk = (name: string, projectId: string) => withTenant(c.app, as("admin"), (s) => createTask(s, { projectId, title: `Render ${name}` })).then((t) => { ids[name] = t.id; });
  await mk("visible", O.project.id);
  await mk("trashed", O.project.id);
  await mk("elsewhere", P2.id); // a project the scoped user cannot read
  const doomed = await withTenant(c.app, as("admin"), (s) => createTask(s, { projectId: O.project.id, title: "Render in a deleted project" }));
  const dead = ((await c.admin.execute(sql`insert into projects (org_id, name, deleted_at) values (${O.org.id}, 'Gone', now()) returning id`)) as unknown as { rows: { id: string }[] }).rows[0]!;
  await c.admin.update(tasks).set({ projectId: dead.id }).where(eq(tasks.id, doomed.id));
  ids.inDeletedProject = doomed.id;
  await c.admin.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, ids.trashed!));
});

const note = (type: string, taskId: string | null, extra: Record<string, unknown> = {}) => ({ orgId: O.org.id, userId: u.p1only!.id, type, taskId, dedupeKey: `r-${Math.random()}`, ...extra });

describe("renderNotifications", () => {
  it("shows what the recipient may read now, and a generic line for everything else", async () => {
    await c.admin.insert(notifications).values([
      note("task.assigned", ids.visible!, { actorId: u.actor!.id }),
      note("task.status_changed", ids.visible!, { params: { status: "progress" } }),
      note("task.assigned", ids.trashed!),
      note("task.assigned", ids.elsewhere!),
      note("task.assigned", ids.inDeletedProject!),
      note("task.assigned", null),
      note("task.something_new", ids.visible!),
      note("task.assigned", "00000000-0000-4000-8000-000000000000"),
    ]);
    const rows = await c.admin.select().from(notifications).where(eq(notifications.userId, u.p1only!.id));
    const out = await withTenant(c.app, as("p1only"), (s) => renderNotifications(s.tx, O.org.id, rows, "en"));
    expect(out).toHaveLength(rows.length);
    const byKey = rows.map((r, i) => ({ type: r.type, task: r.taskId, ...out[i]! }));
    const visible = byKey.filter((x) => x.visible);
    expect(visible).toHaveLength(2);
    expect(visible.map((x) => x.text).sort()).toEqual([expect.stringContaining("Render visible"), expect.stringContaining("Render visible")]);
    expect(visible.some((x) => x.text.includes(" progress") || x.text.toLowerCase().includes("in progress"))).toBe(true);
    for (const hidden of byKey.filter((x) => !x.visible)) {
      expect(hidden.title).toBeNull();
      expect(hidden.taskId).toBeNull();
      expect(hidden.text).not.toContain("Render ");
    }
    // somebody who can read everything sees the task the scoped user cannot
    const adminSees = await withTenant(c.app, as("admin"), (s) => renderNotifications(s.tx, O.org.id, [{ userId: u.admin!.id, type: "task.assigned", taskId: ids.elsewhere!, actorId: null, params: {} }], "en"));
    expect(adminSees[0]).toMatchObject({ visible: true, title: "Render elsewhere" });
    // ... but never a trashed one, or one in a deleted project, whoever asks
    const adminTrashed = await withTenant(c.app, as("admin"), (s) => renderNotifications(s.tx, O.org.id, [ids.trashed!, ids.inDeletedProject!].map((id) => ({ userId: u.admin!.id, type: "task.assigned", taskId: id, actorId: null, params: {} })), "en"));
    expect(adminTrashed.map((x) => x.visible)).toEqual([false, false]);
  });

  it("uses a handful of queries however many notifications there are", async () => {
    await c.admin.insert(notifications).values(Array.from({ length: 40 }, (_, i) => note("task.assigned", ids.visible!, { actorId: u.actor!.id, dedupeKey: `bulk-${i}` })));
    let queries = 0;
    const page = await withTenant(c.app, as("p1only"), (s) => {
      const counting = new Proxy(s.tx, { get: (t, p, r) => { if (p === "select" || p === "execute") queries++; return Reflect.get(t, p, r); } });
      return listNotifications({ ...s, tx: counting }, { limit: 40 });
    });
    expect(page.items.length).toBe(40);
    expect(page.items.every((i) => i.visible || i.text.length > 0)).toBe(true);
    expect(queries).toBeLessThan(14); // it used to be about seven per notification (> 250 here)
  });
});

