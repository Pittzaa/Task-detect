import { getEnv } from "@/config/env";
import { safeEqual } from "@/lib/crypto";
import { kick } from "@/jobs/kick";
import { tick } from "@/jobs/tick";
import { queueStats } from "@/jobs/queue";
import { logger } from "@/lib/logger";
import { getRuntime } from "@/server/runtime";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Called by Vercel Cron or a server cron (GET with `Authorization: Bearer $CRON_SECRET`). Never callable without the secret.
 * `?fast=1` is the quick pass for a poller that calls every second or so (scripts/poller.mjs): it only does what people are waiting for
 * (notifications, e-mails, reminders), at once, and leaves the heavy periodic work to the full pass.
 */
export async function GET(req: Request) {
  const secret = getEnv().CRON_SECRET;
  const given = req.headers.get("authorization") ?? "";
  if (!secret || !safeEqual(given, `Bearer ${secret}`)) return new Response("Unauthorized", { status: 401 });
  const rt = getRuntime();
  if (new URL(req.url).searchParams.get("fast") === "1") {
    const ran = await kick(rt.jobContext(), { force: true, outboxBucketSeconds: 1 });
    return Response.json({ ok: true, fast: true, ran }, { headers: { "cache-control": "no-store" } });
  }
  const stats = await tick(rt.jobContext(), { maxMs: 45_000 });
  const health = await queueStats(rt.db);
  if (health.dead > 0 || health.stuck > 0 || health.oldestPendingSeconds > 600) logger.error({ ...health }, "job queue needs attention");
  return Response.json({ ok: true, ...stats, queue: health }, { headers: { "cache-control": "no-store" } });
}
