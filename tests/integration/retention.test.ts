import { mkdtempSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { withTenant } from "@/data/tenant";
import { uploadAttachment, deleteAttachment } from "@/data/attachments";
import { createField } from "@/data/custom-fields";
import { addComment, addDependency, createLabel, createTask, deleteComment, deleteTask, setAssignees, setTaskCustomValues, setTaskLabels } from "@/data/tasks";
import { createDestination, deleteDestination } from "@/data/integrations";
import {
  attachments, auditLogs, comments, integrationDestinations, jobs, notifications, oauthStates, outboxEvents, taskActivity, tasks, authSessions,
} from "@/db/schema";
import { createFsStore } from "@/integrations/storage/fs";
import { retentionPurge, storageOrphans } from "@/jobs/handlers/retention";
import { registry } from "@/jobs/registry";
import { tick } from "@/jobs/tick";
import type { JobRow } from "@/jobs/queue";
import { addMember, connect, makeOrg, makeUser } from "./helpers";
import { KEY, makeJobCtx } from "./jobs-helpers";

const c = connect();
afterAll(() => c.close());

const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
const JOB = {} as JobRow;

const storeRoot = mkdtempSync(path.join(tmpdir(), "tt-retention-"));
const store = createFsStore(storeRoot);
const { ctx } = makeJobCtx(c.app, { store });

let O: Awaited<ReturnType<typeof makeOrg>>;
let X: Awaited<ReturnType<typeof makeOrg>>;
const u: Record<string, { id: string }> = {};
const as = (k: string, org = O) => ({ userId: u[k]!.id, orgId: org.org.id });
const run = <T>(k: string, fn: Parameters<typeof withTenant<T>>[2], org = O) => withTenant(c.app, as(k, org), fn);
const mk = (title: string, org = O, who = "admin") => run(who, (s) => createTask(s, { projectId: org.project.id, title }), org);
const exists = async (ids: string[]) => (await c.admin.select({ id: tasks.id }).from(tasks).where(inArray(tasks.id, ids))).map((r) => r.id);
const backdate = (ids: string[], days: number) => c.admin.update(tasks).set({ deletedAt: ago(days) }).where(inArray(tasks.id, ids));
const count = async (table: string, where: string) => Number(((await c.admin.execute(sql.raw(`select count(*)::int as n from ${table} where ${where}`))) as unknown as { rows: { n: number }[] }).rows[0]!.n);

beforeAll(async () => {
  O = await makeOrg(c.admin, "RetOrg");
  X = await makeOrg(c.admin, "RetOther");
  for (const k of ["admin", "member", "xadmin"]) u[k] = await makeUser(c.admin, k);
  await addMember(c.admin, O.org.id, u.admin!.id, { role: "orgadmin" });
  await addMember(c.admin, O.org.id, u.member!.id, { role: "member" });
  await addMember(c.admin, X.org.id, u.xadmin!.id, { role: "orgadmin" });
});

describe("audit-log retention is enforced by the database", () => {
  it("removes rows older than 90 days, keeps newer ones, and the argument can never lower the floor", async () => {
    const mark = randomUUID();
    const insert = (days: number) => c.admin.insert(auditLogs).values({ orgId: O.org.id, action: `test.retention.${mark}`, createdAt: ago(days) }).returning({ id: auditLogs.id });
    const [old400] = await insert(400);
    const [old91] = await insert(91);
    const [young89] = await insert(89);
    const [fresh] = await insert(0);
    const [otherOrgOld] = await c.admin.insert(auditLogs).values({ orgId: X.org.id, action: `test.retention.${mark}`, createdAt: ago(120) }).returning({ id: auditLogs.id });

    // asking for "1 day" must still keep 89- and 0-day-old rows
    const r = (await c.app.execute(sql`select purge_audit_logs(1) as n`)) as unknown as { rows: { n: string }[] };
    expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(3);
    const left = (await c.admin.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.action, `test.retention.${mark}`))).map((x) => x.id);
    expect(left.sort()).toEqual([young89!.id, fresh!.id].sort());
    expect(left).not.toContain(old400!.id);
    expect(left).not.toContain(old91!.id);
    expect(left).not.toContain(otherOrgOld!.id); // global: every organization's expired rows

    // a second run finds nothing more to do
    const again = (await c.app.execute(sql`select purge_audit_logs(90) as n`)) as unknown as { rows: { n: string }[] };
    expect(Number(again.rows[0]!.n)).toBe(0);
  });

  it("the application role cannot delete or edit audit rows directly, even pretending to be the worker", async () => {
    const [row] = await c.admin.insert(auditLogs).values({ orgId: O.org.id, action: "test.retention.direct", createdAt: ago(500) }).returning({ id: auditLogs.id });
    for (const stmt of [
      sql`delete from audit_logs where id = ${row!.id}`,
      sql`update audit_logs set action = 'tampered' where id = ${row!.id}`,
      sql`truncate audit_logs`,
    ]) {
      await expect(
        c.app.transaction(async (tx) => {
          await tx.execute(sql`select set_config('app.worker', 'on', true), set_config('app.org_id', ${O.org.id}, true)`);
          await tx.execute(stmt);
        }),
      ).rejects.toThrow();
    }
    expect(await count("audit_logs", `id = '${row!.id}' and action = 'test.retention.direct'`)).toBe(1);
    await c.app.execute(sql`select purge_audit_logs(90)`); // cleanup through the only allowed path
  });
});

describe("trashed tasks are purged completely, and only when due", () => {
  it("removes an old trashed task tree with everything attached to it, keeps everything else, and is idempotent", async () => {
    const field = await run("admin", (s) => createField(s, { name: `Cost-${randomUUID().slice(0, 4)}`, type: "number" }));
    const label = await run("admin", (s) => createLabel(s, { name: `L-${randomUUID().slice(0, 4)}` }));
    const live = await mk("Live prerequisite");
    const parent = await mk("Old parent");
    const kid1 = await run("admin", (s) => createTask(s, { projectId: O.project.id, parentId: parent.id, title: "Old subtask 1" }));
    const kid2 = await run("admin", (s) => createTask(s, { projectId: O.project.id, parentId: parent.id, title: "Old subtask 2" }));
    const solo = await mk("Old solo");
    const recent = await mk("Recently deleted");

    // everything a task can own
    await run("admin", (s) => setAssignees(s, solo.id, { primary: u.member!.id, co: [] }));
    await run("admin", (s) => setTaskLabels(s, solo.id, [label.id]));
    await run("admin", (s) => setTaskCustomValues(s, solo.id, { [field.id]: 12 }));
    await run("admin", (s) => addDependency(s, solo.id, live.id));
    await run("admin", (s) => addDependency(s, live.id, kid1.id)); // a LIVE task depending on a task that will be purged
    await run("admin", (s) => addComment(s, solo.id, { body: "hello @member", mentionUserIds: [u.member!.id] }));
    const file = await run("admin", (s) => uploadAttachment(s, store, solo.id, { name: "a.png", bytes: PNG }));
    const [fileRow] = await c.admin.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.id, file.id));
    expect(await store.get(fileRow!.key)).not.toBeNull();
    await c.admin.insert(notifications).values({ orgId: O.org.id, userId: u.member!.id, type: "mention", taskId: solo.id, dedupeKey: `t:${randomUUID()}` });

    for (const t of [parent, solo, recent]) await run("admin", (s) => deleteTask(s, t.id));
    const trashed = [parent.id, kid1.id, kid2.id, solo.id];
    await backdate(trashed, 31);
    await backdate([recent.id], 10);

    await retentionPurge(ctx, JOB);

    expect(await exists(trashed)).toEqual([]);
    expect(await exists([live.id, recent.id]).then((x) => x.sort())).toEqual([live.id, recent.id].sort());
    for (const [table, col] of [["comments", "task_id"], ["task_activity", "task_id"], ["task_assignees", "task_id"], ["task_labels", "task_id"], ["custom_field_values", "task_id"], ["attachments", "task_id"], ["notifications", "task_id"]] as const) {
      expect(await count(table, `${col} in (${trashed.map((i) => `'${i}'`).join(",")})`), table).toBe(0);
    }
    expect(await count("task_dependencies", `task_id in ('${solo.id}','${kid1.id}') or depends_on_id in ('${solo.id}','${kid1.id}')`)).toBe(0);
    expect(await count("comment_mentions", `org_id = '${O.org.id}'`)).toBe(0);
    expect(await store.get(fileRow!.key)).toBeNull(); // the file went with it
    // the live task's own data is untouched
    expect(await count("task_activity", `task_id = '${live.id}'`)).toBeGreaterThan(0);

    // the audit trail says that data was removed under policy, with counts and no contents
    const audit = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "retention.purge")));
    expect(audit.length).toBeGreaterThanOrEqual(1);
    const meta = audit.at(-1)!.metadata as Record<string, number>;
    expect(meta.tasks).toBe(4);
    expect(meta.attachments).toBe(1);
    expect(JSON.stringify(meta)).not.toMatch(/Old parent|Old solo|hello/);

    // running it again changes nothing and writes no new audit row
    const before = audit.length;
    await retentionPurge(ctx, JOB);
    expect(await exists([live.id, recent.id])).toHaveLength(2);
    expect((await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, O.org.id), eq(auditLogs.action, "retention.purge")))).length).toBe(before);
  });

  it("a trashed parent whose subtask is live again is not purged (nothing live is ever orphaned)", async () => {
    const parent = await mk("Parent kept");
    const kid = await run("admin", (s) => createTask(s, { projectId: O.project.id, parentId: parent.id, title: "Rescued child" }));
    await run("admin", (s) => deleteTask(s, parent.id));
    await backdate([parent.id], 60);
    await c.admin.update(tasks).set({ deletedAt: null }).where(eq(tasks.id, kid.id)); // child rescued independently
    await retentionPurge(ctx, JOB);
    expect((await exists([parent.id, kid.id])).sort()).toEqual([parent.id, kid.id].sort());
  });

  it("purging is per organization: another tenant's trash is purged in its own context and live data is never touched", async () => {
    const xLive = await mk("X live", X, "xadmin");
    const xOld = await mk("X old", X, "xadmin");
    await run("xadmin", (s) => deleteTask(s, xOld.id), X);
    await backdate([xOld.id], 45);
    const oLive = await mk("O live");
    await retentionPurge(ctx, JOB);
    expect(await exists([xOld.id])).toEqual([]);
    expect((await exists([xLive.id, oLive.id])).sort()).toEqual([xLive.id, oLive.id].sort());
    const xAudit = await c.admin.select().from(auditLogs).where(and(eq(auditLogs.orgId, X.org.id), eq(auditLogs.action, "retention.purge")));
    expect(xAudit.length).toBeGreaterThanOrEqual(1);
  });

  it("task history cannot be deleted by a tenant session, nor for a task that is not in the trash", async () => {
    const t = await mk("History stays");
    await expect(
      c.app.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.worker', 'on', true), set_config('app.org_id', ${O.org.id}, true)`);
        const gone = await tx.delete(taskActivity).where(eq(taskActivity.taskId, t.id)).returning({ id: taskActivity.id });
        if (gone.length) throw new Error("history of a live task was deleted");
      }),
    ).resolves.toBeUndefined();
    await expect(
      withTenant(c.app, as("admin"), async (s) => {
        const gone = await s.tx.delete(taskActivity).where(eq(taskActivity.taskId, t.id)).returning({ id: taskActivity.id });
        if (gone.length) throw new Error("tenant deleted history");
      }),
    ).resolves.toBeUndefined();
    expect(await count("task_activity", `task_id = '${t.id}'`)).toBeGreaterThan(0);
  });
});

describe("attachments", () => {
  it("a removed attachment's file is deleted after its grace period, not before", async () => {
    const t = await mk("File owner");
    const a = await run("admin", (s) => uploadAttachment(s, store, t.id, { name: "b.png", bytes: PNG }));
    const b = await run("admin", (s) => uploadAttachment(s, store, t.id, { name: "c.png", bytes: PNG }));
    await run("admin", (s) => deleteAttachment(s, a.id));
    await run("admin", (s) => deleteAttachment(s, b.id));
    const keys = await c.admin.select({ id: attachments.id, key: attachments.storageKey }).from(attachments).where(inArray(attachments.id, [a.id, b.id]));
    const keyOf = (id: string) => keys.find((k) => k.id === id)!.key;
    await c.admin.update(attachments).set({ deletedAt: ago(31) }).where(eq(attachments.id, a.id)); // old
    await c.admin.update(attachments).set({ deletedAt: ago(2) }).where(eq(attachments.id, b.id)); // recent: still restorable
    await retentionPurge(ctx, JOB);
    expect(await count("attachments", `id = '${a.id}'`)).toBe(0);
    expect(await store.get(keyOf(a.id))).toBeNull();
    expect(await count("attachments", `id = '${b.id}'`)).toBe(1);
    expect(await store.get(keyOf(b.id))).not.toBeNull();
  });

  it("the orphan sweep removes unreferenced old objects and leaves referenced and young ones alone", async () => {
    const t = await mk("Orphans");
    const kept = await run("admin", (s) => uploadAttachment(s, store, t.id, { name: "keep.png", bytes: PNG }));
    const [keptRow] = await c.admin.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.id, kept.id));
    const oldOrphan = `orgs/${O.org.id}/tasks/${t.id}/${randomUUID()}`;
    const youngOrphan = `orgs/${O.org.id}/tasks/${t.id}/${randomUUID()}`;
    const oldButReferenced = keptRow!.key;
    await store.put(oldOrphan, PNG);
    await store.put(youngOrphan, PNG);
    const longAgo = new Date(Date.now() - 3 * DAY);
    await utimes(path.join(storeRoot, oldOrphan), longAgo, longAgo);
    await utimes(path.join(storeRoot, oldButReferenced), longAgo, longAgo);

    await storageOrphans(ctx, JOB);

    expect(await store.get(oldOrphan)).toBeNull();
    expect(await store.get(youngOrphan)).not.toBeNull(); // its upload may still be committing
    expect(await store.get(oldButReferenced)).not.toBeNull(); // has a database row
    // each organization is swept against its OWN rows: another tenant's referenced file survives, its orphan does not
    const xTask = await mk("X files", X, "xadmin");
    const xFile = await run("xadmin", (s) => uploadAttachment(s, store, xTask.id, { name: "x.png", bytes: PNG }), X);
    const [xRow] = await c.admin.select({ key: attachments.storageKey }).from(attachments).where(eq(attachments.id, xFile.id));
    const xOrphan = `orgs/${X.org.id}/tasks/${xTask.id}/${randomUUID()}`;
    await store.put(xOrphan, PNG);
    for (const key of [xRow!.key, xOrphan]) await utimes(path.join(storeRoot, key), longAgo, longAgo);
    await storageOrphans(ctx, JOB);
    expect(await store.get(xRow!.key)).not.toBeNull();
    expect(await store.get(xOrphan)).toBeNull();
  });
});

describe("deleted comments and integration destinations", () => {
  it("a deleted comment's text is purged after 30 days (not before); a deleted webhook's secret is destroyed immediately and its row purged later", async () => {
    const t = await mk("Comment host");
    const old = await run("admin", (s) => addComment(s, t.id, { body: "old secret remark", mentionUserIds: [u.member!.id] }));
    const recent = await run("admin", (s) => addComment(s, t.id, { body: "recent remark" }));
    await run("admin", (s) => deleteComment(s, old.id));
    await run("admin", (s) => deleteComment(s, recent.id));
    await c.admin.update(comments).set({ deletedAt: ago(31) }).where(eq(comments.id, old.id));
    await c.admin.update(comments).set({ deletedAt: ago(3) }).where(eq(comments.id, recent.id));

    const deps = { encryptionKeys: [KEY] };
    const dest = await run("admin", (s) => createDestination(s, deps, { name: "Gone", webhookUrl: `https://discord.com/api/webhooks/123456789012345678/${"Z".repeat(40)}`, projectId: O.project.id, events: ["task.assigned"] }));
    await run("admin", (s) => deleteDestination(s, dest.id));
    const [afterDelete] = await c.admin.select({ c: integrationDestinations.webhookCiphertext }).from(integrationDestinations).where(eq(integrationDestinations.id, dest.id));
    expect(afterDelete!.c).toBe("destroyed"); // the secret does not wait for the retention period
    await c.admin.update(integrationDestinations).set({ deletedAt: ago(40) }).where(eq(integrationDestinations.id, dest.id));

    await retentionPurge(ctx, JOB);

    const left = (await c.admin.select({ id: comments.id }).from(comments).where(inArray(comments.id, [old.id, recent.id]))).map((r) => r.id);
    expect(left).toEqual([recent.id]);
    expect(await count("comment_mentions", `comment_id = '${old.id}'`)).toBe(0);
    expect(await count("integration_destinations", `id = '${dest.id}'`)).toBe(0);
  });
});

describe("operational rows", () => {
  it("expired jobs, processed outbox events, auth artefacts and old notifications are removed; recent ones stay", async () => {
    const mark = `ret-${randomUUID()}`;
    const mkJob = (status: "succeeded" | "dead" | "pending", daysAgo: number, tag: string) =>
      c.admin.insert(jobs).values({ kind: "test.noop", dedupeKey: `${mark}:${tag}`, status, finishedAt: status === "pending" ? null : ago(daysAgo), runAt: ago(daysAgo) }).returning({ id: jobs.id });
    const [oldDone] = await mkJob("succeeded", 8, "old-done");
    const [newDone] = await mkJob("succeeded", 1, "new-done");
    const [oldDead] = await mkJob("dead", 31, "old-dead");
    const [recentDead] = await mkJob("dead", 10, "recent-dead");
    const [pendingOld] = await mkJob("pending", 40, "pending");

    const [oldEvent] = await c.admin.insert(outboxEvents).values({ orgId: O.org.id, type: "t", processedAt: ago(8) }).returning({ id: outboxEvents.id });
    const [newEvent] = await c.admin.insert(outboxEvents).values({ orgId: O.org.id, type: "t", processedAt: ago(1) }).returning({ id: outboxEvents.id });
    const [pendingEvent] = await c.admin.insert(outboxEvents).values({ orgId: O.org.id, type: "t", createdAt: ago(40) }).returning({ id: outboxEvents.id });

    const [expiredState] = await c.admin.insert(oauthStates).values({ stateHash: `h-${randomUUID()}`, userId: u.admin!.id, orgId: O.org.id, codeVerifierCiphertext: "x", expiresAt: ago(3) }).returning({ k: oauthStates.stateHash });
    const [liveState] = await c.admin.insert(oauthStates).values({ stateHash: `h-${randomUUID()}`, userId: u.admin!.id, orgId: O.org.id, codeVerifierCiphertext: "x", expiresAt: new Date(Date.now() + 600_000) }).returning({ k: oauthStates.stateHash });
    const [expiredSession] = await c.admin.insert(authSessions).values({ token: `s-${randomUUID()}`, userId: u.admin!.id, expiresAt: ago(3) }).returning({ id: authSessions.id });
    const [liveSession] = await c.admin.insert(authSessions).values({ token: `s-${randomUUID()}`, userId: u.admin!.id, expiresAt: new Date(Date.now() + DAY) }).returning({ id: authSessions.id });

    const oldN = await c.admin.insert(notifications).values({ orgId: O.org.id, userId: u.member!.id, type: "mention", dedupeKey: `n:${randomUUID()}`, createdAt: ago(100) }).returning({ id: notifications.id });
    const newN = await c.admin.insert(notifications).values({ orgId: O.org.id, userId: u.member!.id, type: "mention", dedupeKey: `n:${randomUUID()}`, createdAt: ago(5) }).returning({ id: notifications.id });

    await retentionPurge(ctx, JOB);

    const jobIds = (await c.admin.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, [oldDone!.id, newDone!.id, oldDead!.id, recentDead!.id, pendingOld!.id]))).map((r) => r.id);
    expect(jobIds.sort()).toEqual([newDone!.id, recentDead!.id, pendingOld!.id].sort()); // unfinished work is never purged
    const events = (await c.admin.select({ id: outboxEvents.id }).from(outboxEvents).where(inArray(outboxEvents.id, [oldEvent!.id, newEvent!.id, pendingEvent!.id]))).map((r) => r.id);
    expect(events.sort()).toEqual([newEvent!.id, pendingEvent!.id].sort()); // an unprocessed event is never purged
    expect((await c.admin.select({ k: oauthStates.stateHash }).from(oauthStates).where(inArray(oauthStates.stateHash, [expiredState!.k, liveState!.k]))).map((r) => r.k)).toEqual([liveState!.k]);
    expect((await c.admin.select({ id: authSessions.id }).from(authSessions).where(inArray(authSessions.id, [expiredSession!.id, liveSession!.id]))).map((r) => r.id)).toEqual([liveSession!.id]);
    expect((await c.admin.select({ id: notifications.id }).from(notifications).where(inArray(notifications.id, [oldN[0]!.id, newN[0]!.id]))).map((r) => r.id)).toEqual([newN[0]!.id]);
  });

  it("the scheduler enqueues the daily purge and the weekly orphan sweep, once per period", async () => {
    expect(Object.keys(registry)).toEqual(expect.arrayContaining(["retention.purge", "storage.orphans"]));
    const { ctx: tctx } = makeJobCtx(c.app, { store });
    const when = new Date(Date.now() + 400 * DAY); // a bucket nobody has used yet
    tctx.now = () => when;
    await tick(tctx, { registry: {}, maxMs: 1 });
    await tick(tctx, { registry: {}, maxMs: 1 });
    const rows = await c.admin.select({ kind: jobs.kind }).from(jobs).where(sql`${jobs.dedupeKey} like ${"tick:retention.purge:" + Math.floor(when.getTime() / (86_400 * 1000))}`);
    expect(rows).toHaveLength(1);
    const orphan = await c.admin.select({ kind: jobs.kind }).from(jobs).where(sql`${jobs.dedupeKey} like ${"tick:storage.orphans:" + Math.floor(when.getTime() / (7 * 86_400 * 1000))}`);
    expect(orphan).toHaveLength(1);
  });
});
