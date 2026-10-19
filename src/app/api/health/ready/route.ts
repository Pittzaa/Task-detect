import { sql } from "drizzle-orm";
import { getEnv } from "@/config/env";
import { migrationsStatus } from "@/config/schema-version";
import { checkRlsEnforceable } from "@/db/client";
import { safeEqual } from "@/lib/crypto";
import { queueStats } from "@/jobs/queue";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";

/**
 * Readiness for uptime monitors and post-deploy checks. Requires `Authorization: Bearer $CRON_SECRET` because it
 * reveals operational detail. 503 when the service must not receive traffic; 200 with `degraded` when it works but
 * something needs attention (dead or stuck jobs, a backlog).
 */
export async function GET(req: Request) {
  const secret = getEnv().CRON_SECRET;
  if (!secret || !safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) return new Response("Unauthorized", { status: 401 });
  const { db } = getRuntime();
  const checks: Record<string, { ok: boolean; detail?: string | number }> = {};
  try {
    await db.execute(sql`select 1`);
    checks.database = { ok: true };
  } catch {
    checks.database = { ok: false, detail: "unreachable" };
    return Response.json({ status: "down", checks }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  const rls = await checkRlsEnforceable(db).catch(() => "check failed");
  checks.rowLevelSecurity = rls ? { ok: false, detail: rls } : { ok: true };
  const applied = (await db.execute(sql`select count(*)::int as n from drizzle.__drizzle_migrations`).then((r) => (r as unknown as { rows: { n: number }[] }).rows[0]?.n).catch(() => -1)) ?? -1;
  checks.migrations = migrationsStatus(applied);
  const q = await queueStats(db).catch(() => null);
  const queueOk = !!q && q.dead === 0 && q.stuck === 0 && q.oldestPendingSeconds <= 600;
  checks.jobs = q ? { ok: queueOk, detail: `pending ${q.pending}, dead ${q.dead}, stuck ${q.stuck}, oldest pending ${q.oldestPendingSeconds}s` } : { ok: false, detail: "unreadable" };

  const hardFail = !checks.rowLevelSecurity!.ok || !checks.migrations!.ok;
  const status = hardFail ? "down" : queueOk ? "ok" : "degraded";
  return Response.json({ status, checks }, { status: hardFail ? 503 : 200, headers: { "cache-control": "no-store" } });
}
