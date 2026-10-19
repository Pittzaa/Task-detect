import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimited } from "@/lib/errors";

/**
 * Fixed-window counter in Postgres (works across serverless instances). The upsert is atomic, so concurrent callers cannot both
 * slip under the limit. Takes one unit and says whether it fit, and when the window ends (when the allowance is back).
 */
export async function takeRateLimit(db: Db, key: string, windowSeconds: number, max: number): Promise<{ allowed: boolean; resetAt: Date }> {
  const res = (await db.execute(sql`
    insert into app_rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when app_rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then 1 else app_rate_limits.count + 1 end,
      window_start = case when app_rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then now() else app_rate_limits.window_start end
    returning count, window_start
  `)) as unknown as { rows: { count: number; window_start: Date | string }[] };
  const row = res.rows[0];
  const start = row ? new Date(row.window_start) : new Date();
  return { allowed: (row?.count ?? 1) <= max, resetAt: new Date(start.getTime() + windowSeconds * 1000) };
}

/** `takeRateLimit` that throws RATE_LIMITED when the allowance is used up. */
export async function consumeRateLimit(db: Db, key: string, windowSeconds: number, max: number): Promise<void> {
  if (!(await takeRateLimit(db, key, windowSeconds, max)).allowed) throw rateLimited();
}

/** Gives one unit back (never below zero): for an allowance that was taken but whose purpose did not happen (nothing was sent). */
export async function refundRateLimit(db: Db, key: string): Promise<void> {
  await db.execute(sql`update app_rate_limits set count = greatest(count - 1, 0) where key = ${key}`);
}
