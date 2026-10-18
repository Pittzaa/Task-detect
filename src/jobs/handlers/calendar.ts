import { taskLink } from "@/lib/links";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { calendarConnections, calendarEventLinks, taskAssignees, tasks } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { t, DEFAULT_LOCALE } from "@/i18n";
import { buildEventBody, createGoogleClient, eventIdFor, GoogleError, payloadHash, type EventBody, type GoogleClient } from "@/integrations/google-calendar";
import { addDays } from "@/domain/time";
import { withWorker, withWorkerOrg } from "../context";
import { loadProfiles, readersOf } from "../notify";
import { enqueue } from "../queue";
import { Deferred, PermanentFailure, type JobContext, type JobHandler } from "../worker";

type Conn = typeof calendarConnections.$inferSelect;
type TaskRow = typeof tasks.$inferSelect;

function clientFor(ctx: JobContext): GoogleClient {
  if (!ctx.google) throw new PermanentFailure("GoogleNotConfigured");
  return createGoogleClient(ctx.google, ctx.fetchImpl);
}

/**
 * What the user's calendar SHOULD contain for this task, derived from the database right now (never from an event
 * payload). Returns null when no event should exist:
 *   - the task is deleted or cancelled, has no dates, or the user is not assigned to it,
 *   - the user can no longer read the task (access revoked).
 * Completed tasks keep their event, prefixed with a check mark. Only the title, dates, status/priority and a link
 * are exported; descriptions, comments and attachments never leave the app.
 */
export async function desiredEvent(tx: Tx, ctx: JobContext, conn: Conn, task: TaskRow | undefined): Promise<{ body: EventBody; hash: string } | null> {
  if (!task || task.deletedAt || task.status === "cancelled") return null;
  if (!task.dueDate && !task.startDate) return null;
  const co = (await tx.select({ u: taskAssignees.userId }).from(taskAssignees).where(and(eq(taskAssignees.orgId, conn.orgId), eq(taskAssignees.taskId, task.id)))).map((r) => r.u);
  if (task.primaryAssigneeId !== conn.userId && !co.includes(conn.userId)) return null;
  if (!(await readersOf(tx, conn.orgId, task, [conn.userId])).has(conn.userId)) return null;
  const profile = (await loadProfiles(tx, [conn.userId])).get(conn.userId);
  const locale = profile?.locale ?? DEFAULT_LOCALE;
  const url = taskLink(ctx.appUrl, conn.orgId, task.id);
  const body = buildEventBody({
    title: task.title, startDate: task.startDate, dueDate: task.dueDate, done: task.status === "done", url, appName: t(locale, "app.name"),
    description: `${t(locale, "ui.status")}: ${t(locale, `status.${task.status}` as never)} · ${t(locale, "ui.priority")}: ${t(locale, `priority.${task.priority}` as never)}\n${url}`,
  });
  return { body, hash: payloadHash(body) };
}

async function accessToken(ctx: JobContext, google: GoogleClient, conn: Conn): Promise<string> {
  try {
    const refreshToken = decryptSecret(conn.refreshTokenCiphertext, ctx.encryptionKeys, `cal:${conn.id}`);
    return (await google.refresh(refreshToken)).accessToken;
  } catch (e) {
    if (e instanceof GoogleError && e.kind === "revoked") {
      await withWorkerOrg(ctx.db, conn.orgId, (tx) => tx.update(calendarConnections).set({ status: "revoked", lastError: "access_revoked" }).where(eq(calendarConnections.id, conn.id)));
      throw new PermanentFailure("GoogleAccessRevoked");
    }
    throw mapGoogle(e);
  }
}

function mapGoogle(e: unknown): Error {
  if (e instanceof GoogleError) {
    if (e.kind === "rate_limited") return new Deferred(new Date(Date.now() + (e.retryAfterMs ?? 60_000)), "google_rate_limited");
    if (e.kind === "permanent" || e.kind === "revoked") return new PermanentFailure(`Google:${e.status}`);
    return Object.assign(new Error("GoogleUnavailable"), { status: e.status || 503 });
  }
  return e as Error;
}

/** One-way sync of a single task to a single user's calendar. Idempotent and safe to retry or run twice. */
export const calendarSyncTask: JobHandler = async (ctx, job) => {
  const orgId = job.orgId;
  const { connectionId, taskId } = job.payload as { connectionId?: string; taskId?: string };
  if (!orgId || !connectionId || !taskId) throw new PermanentFailure("MalformedJob");

  const state = await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const [conn] = await tx.select().from(calendarConnections).where(and(eq(calendarConnections.orgId, orgId), eq(calendarConnections.id, connectionId)));
    if (!conn || conn.status !== "active") return null;
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.id, taskId)));
    const [link] = await tx.select().from(calendarEventLinks).where(and(eq(calendarEventLinks.connectionId, connectionId), eq(calendarEventLinks.taskId, taskId)));
    return { conn, link, desired: await desiredEvent(tx, ctx, conn, task) };
  });
  if (!state) return;
  const { conn, link, desired } = state;
  if (!desired && !link) return; // nothing to create and nothing to remove
  if (desired && link && link.payloadHash === desired.hash) return; // already in sync

  const google = clientFor(ctx);
  const token = await accessToken(ctx, google, conn);
  const eventId = link?.googleEventId ?? eventIdFor(connectionId, taskId);
  try {
    if (!desired) {
      await google.deleteEvent(token, conn.calendarId, eventId);
      await withWorkerOrg(ctx.db, orgId, (tx) => tx.delete(calendarEventLinks).where(and(eq(calendarEventLinks.connectionId, connectionId), eq(calendarEventLinks.taskId, taskId))));
    } else {
      await google.upsertEvent(token, conn.calendarId, eventId, desired.body, !!link);
      await withWorkerOrg(ctx.db, orgId, (tx) =>
        tx.insert(calendarEventLinks).values({ orgId, connectionId, taskId, googleEventId: eventId, payloadHash: desired.hash })
          .onConflictDoUpdate({ target: [calendarEventLinks.connectionId, calendarEventLinks.taskId], set: { payloadHash: desired.hash, syncedAt: ctx.now(), failures: 0, lastError: null } }));
    }
    await withWorkerOrg(ctx.db, orgId, (tx) => tx.update(calendarConnections).set({ lastSyncAt: ctx.now(), lastError: null }).where(eq(calendarConnections.id, connectionId)));
  } catch (e) {
    const mapped = mapGoogle(e);
    await withWorkerOrg(ctx.db, orgId, async (tx) => {
      const cls = e instanceof GoogleError ? `${e.kind}:${e.status}` : "error";
      await tx.update(calendarConnections).set({ lastError: cls }).where(eq(calendarConnections.id, connectionId));
      if (link) await tx.update(calendarEventLinks).set({ failures: sql`${calendarEventLinks.failures} + 1`, lastError: cls }).where(and(eq(calendarEventLinks.connectionId, connectionId), eq(calendarEventLinks.taskId, taskId)));
    });
    throw mapped;
  }

  // A concurrent edit may have landed while we were talking to Google. If the target changed, go around again.
  const after = await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.id, taskId)));
    return desiredEvent(tx, ctx, conn, task);
  });
  if ((after?.hash ?? null) !== (desired?.hash ?? null)) {
    await withWorkerOrg(ctx.db, orgId, (tx) => enqueue(tx, { kind: "calendar.sync_task", orgId, payload: { connectionId, taskId }, runAt: ctx.now(), maxAttempts: 6 }));
  }
};

/** Re-queues a sync for every task that is, or should be, in this user's calendar. Used after (re)connecting and by the daily reconcile. */
export const calendarResync: JobHandler = async (ctx, job) => {
  const orgId = job.orgId;
  const connectionId = job.payload.connectionId;
  if (!orgId || typeof connectionId !== "string") throw new PermanentFailure("MalformedJob");
  const bucket = Math.floor(ctx.now().getTime() / 3_600_000);
  await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const [conn] = await tx.select().from(calendarConnections).where(and(eq(calendarConnections.orgId, orgId), eq(calendarConnections.id, connectionId)));
    if (!conn || conn.status !== "active") return;
    const today = ctx.now().toISOString().slice(0, 10);
    const assigned = await tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.orgId, orgId), isNull(tasks.deletedAt), or(eq(tasks.primaryAssigneeId, conn.userId), sql`exists (select 1 from task_assignees a where a.task_id = ${tasks.id} and a.org_id = ${tasks.orgId} and a.user_id = ${conn.userId})`),
        sql`coalesce(${tasks.dueDate}, ${tasks.startDate}) >= ${addDays(today, -30)}`, sql`coalesce(${tasks.startDate}, ${tasks.dueDate}) <= ${addDays(today, 365)}`))
      .limit(500);
    const linked = await tx.select({ id: calendarEventLinks.taskId }).from(calendarEventLinks).where(eq(calendarEventLinks.connectionId, connectionId)).limit(1000);
    for (const id of new Set([...assigned.map((r) => r.id), ...linked.map((r) => r.id)])) {
      await enqueue(tx, { kind: "calendar.sync_task", orgId, payload: { connectionId, taskId: id }, dedupeKey: `resync:${connectionId}:${id}:${bucket}`, maxAttempts: 6, runAt: ctx.now() });
    }
  });
};

/** Disconnecting: optionally remove the events we created, then revoke the token and delete the connection. */
export const calendarCleanup: JobHandler = async (ctx, job) => {
  const orgId = job.orgId;
  const { connectionId, deleteEvents } = job.payload as { connectionId?: string; deleteEvents?: boolean };
  if (!orgId || !connectionId) throw new PermanentFailure("MalformedJob");
  const conn = await withWorkerOrg(ctx.db, orgId, async (tx) => (await tx.select().from(calendarConnections).where(and(eq(calendarConnections.orgId, orgId), eq(calendarConnections.id, connectionId))))[0]);
  if (!conn) return;
  const google = clientFor(ctx);
  let token: string | null = null;
  if (deleteEvents) {
    try { token = await accessToken(ctx, google, conn); } catch (e) { if (!(e instanceof PermanentFailure)) throw e; }
    if (token) {
      const links = await withWorkerOrg(ctx.db, orgId, (tx) => tx.select().from(calendarEventLinks).where(eq(calendarEventLinks.connectionId, connectionId)).limit(50));
      for (const l of links) {
        try { await google.deleteEvent(token, conn.calendarId, l.googleEventId); } catch (e) { throw mapGoogle(e); }
        await withWorkerOrg(ctx.db, orgId, (tx) => tx.delete(calendarEventLinks).where(and(eq(calendarEventLinks.connectionId, connectionId), eq(calendarEventLinks.taskId, l.taskId))));
      }
      if (links.length === 50) {
        await withWorkerOrg(ctx.db, orgId, (tx) => enqueue(tx, { kind: "calendar.cleanup", orgId, payload: { connectionId, deleteEvents }, runAt: ctx.now() }));
        return;
      }
    }
  }
  try { await google.revoke(decryptSecret(conn.refreshTokenCiphertext, ctx.encryptionKeys, `cal:${conn.id}`)); } catch { /* best effort */ }
  await withWorkerOrg(ctx.db, orgId, async (tx) => {
    await tx.delete(calendarEventLinks).where(eq(calendarEventLinks.connectionId, connectionId));
    await tx.delete(calendarConnections).where(eq(calendarConnections.id, connectionId));
  });
};

/** Daily safety net: re-queue a sync for every active connection so drift (missed events, manual deletions in Google is NOT read back) is corrected from our side only. */
export const calendarReconcile: JobHandler = async (ctx) => {
  const rows = await withWorker(ctx.db, (tx) => tx.select({ id: calendarConnections.id, orgId: calendarConnections.orgId }).from(calendarConnections).where(eq(calendarConnections.status, "active")).limit(500));
  const day = ctx.now().toISOString().slice(0, 10);
  for (const c of rows) await withWorkerOrg(ctx.db, c.orgId, (tx) => enqueue(tx, { kind: "calendar.resync", orgId: c.orgId, payload: { connectionId: c.id }, dedupeKey: `reconcile:${c.id}:${day}`, maxAttempts: 3, runAt: ctx.now() }));
};

