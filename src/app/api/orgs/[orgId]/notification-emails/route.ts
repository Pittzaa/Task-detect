import { after } from "next/server";
import { queueWaitingEmails, waitingEmailCount } from "@/data/notification-emails";
import { runWorker } from "@/jobs/worker";
import { registry } from "@/jobs/registry";
import { handle } from "@/server/api";

export const maxDuration = 60;

type P = { params: Promise<{ orgId: string }> };

/** How many notification e-mails wait for an administrator to send them (needs the manage-settings permission). */
export const GET = (req: Request, { params }: P) =>
  handle(req, async (c) => ({ waiting: await c.tenant((await params).orgId, (s) => waitingEmailCount(s)) }));

/**
 * "Send the waiting e-mails now" (works with automatic e-mail on or off). Queues them and starts delivering as soon as the response is out; whatever
 * is left is picked up by the next background run. Answers with how many were queued and whether more are waiting.
 */
export const POST = (req: Request, { params }: P) =>
  handle(req, async (c) => {
    const r = await c.tenant((await params).orgId, (s) => queueWaitingEmails(s));
    if (r.queued) {
      const ctx = c.rt.jobContext();
      try { after(() => runWorker(ctx, { "notification.email": registry["notification.email"]! }, { maxMs: 40_000 }).catch(() => undefined)); } catch { /* not inside a request */ }
    }
    return r;
  }, { limit: { name: "send-waiting-emails", windowSeconds: 60, max: 6 } });
