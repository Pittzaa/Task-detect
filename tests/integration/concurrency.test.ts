import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { bulkUpdate } from "@/data/bulk";
import { createTask, deleteTask, restoreTask, changeStatus } from "@/data/tasks";
import { uploadAttachment } from "@/data/attachments";
import { attachments, appRateLimits } from "@/db/schema";
import { MAX_ATTACHMENTS_PER_TASK } from "@/domain/files";
import { AppError } from "@/lib/errors";
import { createFsStore } from "@/integrations/storage/fs";
import { consumeRateLimit } from "@/server/rate-limit";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addMember, connect, makeOrg, makeUser } from "./helpers";

const c = connect();
afterAll(() => c.close());

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const store = createFsStore(mkdtempSync(path.join(tmpdir(), "tt-conc-")));
const code = async (p: Promise<unknown>) => { try { await p; return "OK"; } catch (e) { return e instanceof AppError ? e.code : `RAW:${(e as Error).message}`; } };

let O: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(c.app, { userId: u[k]!.id, orgId: O.org.id }, fn);

beforeAll(async () => {
  O = await makeOrg(c.admin, "ConcOrg");
  for (const k of ["admin", "m1", "m2", "m3", "m4"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  for (const k of ["m1", "m2", "m3", "m4"]) await addMember(c.admin, O.org.id, u[k]!.id, { role: "manager" });
});

describe("races", () => {
  it("the rate limiter is atomic: 60 simultaneous callers get exactly `max` through", async () => {
    await c.admin.delete(appRateLimits);
    const results = await Promise.all(Array.from({ length: 60 }, () => code(consumeRateLimit(c.app, "race:test", 60, 10))));
    expect(results.filter((r) => r === "OK")).toHaveLength(10);
    expect(results.filter((r) => r === "RATE_LIMITED")).toHaveLength(50);
    expect(results.filter((r) => r !== "OK" && r !== "RATE_LIMITED")).toEqual([]);
  });

  it("simultaneous uploads from several users cannot push a task past its attachment cap", async () => {
    await c.admin.delete(appRateLimits);
    const t = await run("admin", (s) => createTask(s, { projectId: O.project.id, title: "Cap race" }));
    const users = ["m1", "m2", "m3", "m4"];
    const attempts = Array.from({ length: 36 }, (_, i) => code(run(users[i % 4]!, (s) => uploadAttachment(s, store, t.id, { name: `f${i}.png`, bytes: PNG }))));
    const results = await Promise.all(attempts);
    const stored = (await c.admin.select({ id: attachments.id }).from(attachments).where(and(eq(attachments.taskId, t.id), isNull(attachments.deletedAt)))).length;
    expect(results.filter((r) => r !== "OK" && r !== "VALIDATION" && r !== "RATE_LIMITED"), "only clean refusals").toEqual([]);
    expect(stored).toBeLessThanOrEqual(MAX_ATTACHMENTS_PER_TASK);
    expect(results.filter((r) => r === "OK")).toHaveLength(stored);
  });

  it("two bulk updates over the same tasks in opposite orders neither deadlock nor lose items", async () => {
    await c.admin.delete(appRateLimits);
    const tasks = await Promise.all(Array.from({ length: 24 }, (_, i) => run("admin", (s) => createTask(s, { projectId: O.project.id, title: `Bulk ${i}` }))));
    const ids = tasks.map((t) => t.id);
    const [a, b] = await Promise.all([
      run("m1", (s) => bulkUpdate(s, { taskIds: ids, action: { type: "priority", priority: "high" } })),
      run("m2", (s) => bulkUpdate(s, { taskIds: [...ids].reverse(), action: { type: "priority", priority: "urgent" } })),
    ]);
    expect(a.results.filter((r) => !r.ok)).toEqual([]);
    expect(b.results.filter((r) => !r.ok)).toEqual([]);
    expect(a.results.map((r) => r.taskId)).toEqual(ids); // results keep the caller's order
    expect(b.results.map((r) => r.taskId)).toEqual([...ids].reverse());
  });

  it("deleting, restoring and changing status of the same task at once leaves a valid state and no server errors", async () => {
    for (let round = 0; round < 5; round++) {
      const t = await run("admin", (s) => createTask(s, { projectId: O.project.id, title: `Flip ${round}` }));
      const results = await Promise.all([
        code(run("admin", (s) => deleteTask(s, t.id))),
        code(run("m1", (s) => changeStatus(s, t.id, "progress"))),
        code(run("m2", (s) => restoreTask(s, t.id))),
        code(run("m3", (s) => deleteTask(s, t.id))),
        code(run("m4", (s) => changeStatus(s, t.id, "blocked"))),
      ]);
      expect(results.filter((r) => r.startsWith("RAW:")), `round ${round}: ${results.join(",")}`).toEqual([]);
      const [row] = await c.admin.execute(sql`select status, deleted_at is not null as deleted, completed_at from tasks where id = ${t.id}`).then((r) => (r as unknown as { rows: { status: string; deleted: boolean; completed_at: string | null }[] }).rows);
      expect(["todo", "progress", "blocked"]).toContain(row!.status);
    }
  });
});
