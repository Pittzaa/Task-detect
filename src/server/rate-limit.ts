import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { rateLimited } from "@/lib/errors";

/**
 * Fixed-window counter in Postgres (works across serverless instances). The upsert is atomic, so
 * concurrent requests cannot both slip under the limit. Throws RATE_LIMITED when exceeded.
 */
export async function consumeRateLimit(db: Db, key: string, windowSeconds: number, max: number): Promise<void> {
  const res = (await db.execute(sql`
    insert into app_rate_limits (key, window_start, count) values (${key}, now(), 1)
    on conflict (key) do update set
      count = case when app_rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then 1 else app_rate_limits.count + 1 end,
      window_start = case when app_rate_limits.window_start < now() - make_interval(secs => ${windowSeconds}) then now() else app_rate_limits.window_start end
    returning count
  `)) as unknown as { rows: { count: number }[] };
  const count = res.rows[0]?.count ?? 1;
  if (count > max) throw rateLimited();
}
