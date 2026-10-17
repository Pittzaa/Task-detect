import { getEnv } from "@/config/env";
import { safeEqual } from "@/lib/crypto";
import { tick } from "@/jobs/tick";
import { queueStats } from "@/jobs/queue";
import { logger } from "@/lib/logger";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Called by Vercel Cron (GET with `Authorization: Bearer $CRON_SECRET`). Never callable without the secret. */
export async function GET(req: Request) {
  const secret = getEnv().CRON_SECRET;
  const given = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) return new Response("Unauthorized", { status: 401 });
  const rt = getRuntime();
  const stats = await tick(rt.jobContext(), { maxMs: 45_000 });
  const health = await queueStats(rt.db);
  if (health.dead > 0 || health.stuck > 0 || health.oldestPendingSeconds > 600) logger.error({ ...health }, "job queue needs attention");
  return Response.json({ ok: true, ...stats, queue: health }, { headers: { "cache-control": "no-store" } });
}
