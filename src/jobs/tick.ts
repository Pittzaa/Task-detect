import { withWorker } from "./context";
import { enqueue } from "./queue";
import { registry as defaultRegistry } from "./registry";
import { runWorker, type JobContext, type Registry, type RunStats } from "./worker";

/** [kind, bucket size in seconds]. A job's dedupe key includes its time bucket, so overlapping ticks enqueue it once. */
const PERIODIC: [string, number][] = [
  ["outbox.process", 60],
  ["reminders.scan", 300],
  ["digest.run", 3600],
  ["series.generate", 3600],
  ["calendar.reconcile", 86_400],
];

/**
 * Vercel Cron calls this about once a minute. Cron is only the *alarm clock*: it enqueues periodic work (deduped
 * per time bucket) and drains the queue for a bounded time. Reliability (retries, leases, dead-letter) lives in
 * the jobs table, so a missed or doubled cron invocation is harmless.
 */
export async function tick(ctx: JobContext, o: { registry?: Registry; maxMs?: number } = {}): Promise<RunStats> {
  const now = ctx.now();
  await withWorker(ctx.db, async (tx) => {
    for (const [kind, seconds] of PERIODIC) {
      const bucket = Math.floor(now.getTime() / (seconds * 1000));
      await enqueue(tx, { kind, orgId: null, dedupeKey: `tick:${kind}:${bucket}`, runAt: now, maxAttempts: 3 });
    }
  });
  return runWorker(ctx, o.registry ?? defaultRegistry, { maxMs: o.maxMs ?? 50_000 });
}
