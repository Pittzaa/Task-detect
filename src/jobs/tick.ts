import { withWorker } from "./context";
import { enqueue } from "./queue";
import { registry as defaultRegistry } from "./registry";
import { runWorker, type JobContext, type Registry, type RunStats } from "./worker";

/** [kind, bucket size in seconds]. A job's dedupe key includes its time bucket, so overlapping ticks enqueue it once. */
const PERIODIC: [string, number][] = [
  ["outbox.process", 60],
  ["reminders.scan", 300],
  ["digest.run", 3600], // the handler skips every organization that has not switched on automatic e-mail
  ["series.generate", 3600],
  ["calendar.reconcile", 86_400],
  ["retention.purge", 86_400],
  ["storage.orphans", 7 * 86_400],
];

/**
 * Vercel Cron calls this (once a minute on Pro, once a day on Hobby; see kick.ts for what covers the gaps). Cron is only the *alarm clock*: it enqueues periodic work (deduped
 * per time bucket) and drains the queue for a bounded time. Reliability (retries, leases, dead-letter) lives in
 * the jobs table, so a missed or doubled cron invocation is harmless.
 */
export async function tick(ctx: JobContext, o: { registry?: Registry; maxMs?: number; /** Queue only these periodic kinds (a runner that cannot run the rest must not leave them waiting). */ only?: readonly string[] } = {}): Promise<RunStats> {
  const now = ctx.now();
  await withWorker(ctx.db, async (tx) => {
    for (const [kind, seconds] of PERIODIC) {
      if (o.only && !o.only.includes(kind)) continue;
      const bucket = Math.floor(now.getTime() / (seconds * 1000));
      await enqueue(tx, { kind, orgId: null, dedupeKey: `tick:${kind}:${bucket}`, runAt: now, maxAttempts: 3 });
    }
  });
  return runWorker(ctx, o.registry ?? defaultRegistry, { maxMs: o.maxMs ?? 50_000 });
}
