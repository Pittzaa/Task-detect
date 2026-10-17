import { sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { jobs } from "@/db/schema";
import { withWorker } from "./context";

export type JobRow = typeof jobs.$inferSelect;

export interface EnqueueOptions {
  kind: string;
  orgId?: string | null;
  payload?: Record<string, unknown>;
  runAt?: Date;
  /** Enqueueing the same key again is a no-op, which makes producers safe to retry. */
  dedupeKey?: string;
  maxAttempts?: number;
}

/** Works inside any transaction, so a producer can enqueue atomically with its own change. */
export async function enqueue(tx: Pick<Tx, "insert">, o: EnqueueOptions): Promise<{ created: boolean }> {
  const rows = await tx
    .insert(jobs)
    .values({
      kind: o.kind, orgId: o.orgId ?? null, payload: o.payload ?? {}, runAt: o.runAt ?? new Date(),
      dedupeKey: o.dedupeKey ?? null, maxAttempts: o.maxAttempts ?? 5,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey, where: sql`${jobs.dedupeKey} is not null` })
    .returning({ id: jobs.id });
  return { created: rows.length > 0 };
}

/** 30s, 60s, 120s ... capped at one hour, with up to 20% jitter. `attempts` is the number of tries already made. */
export function backoffSeconds(attempts: number, random = Math.random()): number {
  const base = Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
  return Math.round(base * (1 + 0.2 * random));
}

/**
 * Atomically claims up to `limit` runnable jobs: pending ones that are due, and running ones whose lease
 * expired (a crashed worker). `FOR UPDATE SKIP LOCKED` lets several workers poll concurrently without
 * ever claiming the same job. A job that keeps dying (attempts exhausted) is parked as `dead`.
 */
export async function claimJobs(db: Db, o: { limit: number; leaseSeconds: number; workerId: string; now?: Date; kinds?: string[] }): Promise<JobRow[]> {
  const now = o.now ?? new Date();
  // Only claim kinds this worker knows. During a rolling deploy a newer version may enqueue a kind an older
  // worker cannot run; leaving it pending lets a newer worker take it instead of the old one killing it.
  const kindFilter = o.kinds ? sql`and kind in (${sql.join(o.kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;
  if (o.kinds && o.kinds.length === 0) return [];
  return withWorker(db, async (tx) => {
    await tx.execute(sql`
      update jobs set status = 'dead', last_error = 'lease_expired_attempts_exhausted', finished_at = ${now}, updated_at = ${now}
      where status = 'running' and locked_until < ${now} and attempts >= max_attempts ${kindFilter}`);
    const res = (await tx.execute(sql`
      with picked as (
        select id from jobs
        where ((status = 'pending' and run_at <= ${now}) or (status = 'running' and locked_until < ${now} and attempts < max_attempts)) ${kindFilter}
        order by run_at, created_at
        limit ${o.limit}
        for update skip locked
      )
      update jobs j set status = 'running', attempts = j.attempts + 1,
        locked_until = ${new Date(now.getTime() + o.leaseSeconds * 1000)}, locked_by = ${o.workerId}, updated_at = ${now}
      from picked where j.id = picked.id
      returning j.id, j.org_id as "orgId", j.kind, j.payload, j.dedupe_key as "dedupeKey", j.status, j.run_at as "runAt",
        j.attempts, j.max_attempts as "maxAttempts", j.locked_until as "lockedUntil", j.locked_by as "lockedBy",
        j.last_error as "lastError", j.created_at as "createdAt", j.updated_at as "updatedAt", j.finished_at as "finishedAt"`)) as unknown as { rows: JobRow[] };
    return res.rows.map((r) => ({ ...r, runAt: new Date(r.runAt), lockedUntil: r.lockedUntil ? new Date(r.lockedUntil) : null, createdAt: new Date(r.createdAt), updatedAt: new Date(r.updatedAt) }));
  });
}

/** Marks success only if this worker still owns the lease (a slow worker must not clobber a re-claimed job). */
export async function completeJob(db: Db, job: JobRow, now = new Date()): Promise<boolean> {
  return withWorker(db, async (tx) => {
    const res = (await tx.execute(sql`update jobs set status = 'succeeded', finished_at = ${now}, updated_at = ${now}, locked_until = null, last_error = null where id = ${job.id} and locked_by = ${job.lockedBy} and status = 'running' returning id`)) as unknown as { rows: unknown[] };
    return res.rows.length > 0;
  });
}

/** Retry later with backoff, or park as dead once attempts are exhausted. `errorClass` must contain no secrets or payloads. */
export async function failJob(db: Db, job: JobRow, errorClass: string, o: { permanent?: boolean; now?: Date; random?: number } = {}): Promise<"retry" | "dead"> {
  const now = o.now ?? new Date();
  const dead = o.permanent || job.attempts >= job.maxAttempts;
  return withWorker(db, async (tx) => {
    if (dead) {
      await tx.execute(sql`update jobs set status = 'dead', last_error = ${errorClass.slice(0, 200)}, finished_at = ${now}, updated_at = ${now}, locked_until = null where id = ${job.id} and locked_by = ${job.lockedBy}`);
      return "dead" as const;
    }
    const next = new Date(now.getTime() + backoffSeconds(job.attempts, o.random) * 1000);
    await tx.execute(sql`update jobs set status = 'pending', run_at = ${next}, last_error = ${errorClass.slice(0, 200)}, updated_at = ${now}, locked_until = null where id = ${job.id} and locked_by = ${job.lockedBy}`);
    return "retry" as const;
  });
}

/** Re-schedules without counting the try as a failure (quiet hours, provider asked us to wait). */
export async function deferJob(db: Db, job: JobRow, runAt: Date, reason: string, now = new Date()): Promise<void> {
  await withWorker(db, async (tx) => {
    await tx.execute(sql`update jobs set status = 'pending', run_at = ${runAt}, attempts = greatest(attempts - 1, 0), last_error = ${reason.slice(0, 200)}, updated_at = ${now}, locked_until = null where id = ${job.id} and locked_by = ${job.lockedBy}`);
  });
}

/** Counters for monitoring and the admin status page. */
export async function queueStats(db: Db, now = new Date()) {
  return withWorker(db, async (tx) => {
    const res = (await tx.execute(sql`
      select
        count(*) filter (where status = 'pending')::int as pending,
        count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'dead')::int as dead,
        count(*) filter (where status = 'running' and locked_until < ${now})::int as stuck,
        coalesce(extract(epoch from (${now}::timestamptz - min(run_at) filter (where status = 'pending' and run_at <= ${now})))::int, 0) as oldest_pending_seconds
      from jobs`)) as unknown as { rows: { pending: number; running: number; dead: number; stuck: number; oldest_pending_seconds: number }[] };
    const r = res.rows[0]!;
    return { pending: r.pending, running: r.running, dead: r.dead, stuck: r.stuck, oldestPendingSeconds: r.oldest_pending_seconds };
  });
}
