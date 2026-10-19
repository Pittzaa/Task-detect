import { withWorker } from "./context";
import { enqueue } from "./queue";
import { USER_FACING_KINDS, registry as defaultRegistry } from "./registry";
import { runWorker, type JobContext, type Registry, type RunStats } from "./worker";

const add = (a: RunStats, b: RunStats): RunStats => ({ processed: a.processed + b.processed, succeeded: a.succeeded + b.succeeded, retried: a.retried + b.retried, dead: a.dead + b.dead, deferred: a.deferred + b.deferred });

/** [kind, bucket size in seconds]. A job's dedupe key includes its time bucket, so overlapping ticks enqueue it once. */
export const PERIODIC: [string, number][] = [
  ["outbox.process", 60],
  ["reminders.scan", 300],
  ["deadline.email", 3600], // one e-mail a person a day, from 09:00 local; the handler serves only organizations with automatic e-mail on
  ["digest.run", 3600], // likewise
  ["series.generate", 3600],
  ["calendar.reconcile", 86_400],
  ["retention.purge", 86_400],
  ["storage.orphans", 7 * 86_400],
];

/**
 * The cron calls this: every minute on a server or a paid Vercel plan, once a day (vercel.json) on Vercel Hobby; kick.ts covers the gaps
 * while people use the app. Cron is only the *alarm clock*: it enqueues periodic work (deduped per time bucket) and drains the queue for a
 * bounded time, user-facing kinds first (notifications, e-mails, reminders...), then everything else in the time left. Reliability
 * (retries, leases, dead-letter) lives in the jobs table, so a missed, doubled or cut-short cron invocation is harmless.
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
  const reg = o.registry ?? defaultRegistry;
  const total = o.maxMs ?? 50_000;
  const deadline = Date.now() + total;
  const isUserFacing = ([k]: [string, unknown]) => (USER_FACING_KINDS as readonly string[]).includes(k);
  const first: Registry = Object.fromEntries(Object.entries(reg).filter(isUserFacing));
  const rest: Registry = Object.fromEntries(Object.entries(reg).filter((e) => !isUserFacing(e)));
  // What people notice goes first but may not take everything: housekeeping (digests, sweeps) always gets the last share of the run,
  // and a user-facing backlog that does not fit continues on the next request or run.
  const hasRest = Object.keys(rest).length > 0;
  const a = await runWorker(ctx, first, { maxMs: hasRest ? Math.floor(total * 0.6) : total });
  const b = hasRest ? await runWorker(ctx, rest, { maxMs: Math.max(0, deadline - Date.now()) }) : { processed: 0, succeeded: 0, retried: 0, dead: 0, deferred: 0 };
  return add(a, b);
}
