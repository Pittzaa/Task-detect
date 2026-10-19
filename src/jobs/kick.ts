import { sql } from "drizzle-orm";
import { logger } from "@/lib/logger";
import { withWorker } from "./context";
import { enqueue } from "./queue";
import { registry } from "./registry";
import { tick } from "./tick";
import type { JobContext, Registry } from "./worker";

/**
 * Hosting without a per-minute scheduler (Vercel Hobby allows one cron run a day) still has to
 * show notifications in the web app. So the background work also runs when the app is being used: a signed-in request asks for `kick`
 * after its response has been sent, and the people who are using the app are the ones who need fresh notifications.
 *
 * It only does the light, user-facing kinds below. Digests, the daily calendar reconcile and the retention/orphan sweeps are left to the
 * daily cron (/api/cron/tick), which is what they were always for. Everything is the same job system as with a scheduler, so leases,
 * retries and de-duplication apply unchanged and a kick that is cut short loses nothing.
 */
const LIGHT_KINDS = ["outbox.process", "notification.email", "discord.send", "reminders.scan", "series.generate", "calendar.sync_task", "calendar.resync", "calendar.cleanup"] as const;
const lightRegistry: Registry = Object.fromEntries(LIGHT_KINDS.map((k) => [k, registry[k]!]));

/** At most one kick per instance in this many milliseconds. */
export const KICK_MIN_GAP_MS = 5_000;
/** Bounded so the work after a response stays inside the shortest function time limit. */
export const KICK_MAX_MS = 8_000;

const state = globalThis as typeof globalThis & { __ttKick?: { last: number; running: boolean } };

/**
 * Runs due background work for a bounded time. Never throws. Returns false when it did nothing (another kick ran moments ago or is still running on this instance).
 */
export async function kick(ctx: JobContext, o: { force?: boolean } = {}): Promise<boolean> {
  const s = (state.__ttKick ??= { last: 0, running: false });
  const t = Date.now();
  if (s.running || (!o.force && t - s.last < KICK_MIN_GAP_MS)) return false;
  s.running = true;
  s.last = t;
  try {
    const now = ctx.now();
    // A change made a moment ago should reach the other people's bells now, not at the next minute bucket of the periodic job.
    await withWorker(ctx.db, async (tx) => {
      const res = (await tx.execute(sql`select 1 as one from outbox_events where processed_at is null limit 1`)) as unknown as { rows: unknown[] };
      if (res.rows.length) await enqueue(tx, { kind: "outbox.process", orgId: null, dedupeKey: `kick:outbox:${Math.floor(now.getTime() / 10_000)}`, runAt: now, maxAttempts: 3 });
    });
    await tick(ctx, { registry: lightRegistry, only: LIGHT_KINDS, maxMs: KICK_MAX_MS });
    return true;
  } catch (e) {
    logger.warn({ err: e instanceof Error ? e.constructor.name : "unknown" }, "request-driven background run failed");
    return false;
  } finally {
    s.running = false;
  }
}
