import { and, eq, isNull, sql } from "drizzle-orm";
import { deliveryAttempts, integrationDestinations, projectTeams, tasks } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { parseWebhookUrl, plain, postWebhook } from "@/integrations/discord";
import { DEFAULT_LOCALE, t } from "@/i18n";
import { withWorkerOrg } from "../context";
import { Deferred, PermanentFailure, type JobHandler } from "../worker";

const MAX_CONSECUTIVE_FAILURES = 10;

const LABEL: Record<string, { th: string; en: string }> = {
  "task.created": { th: "มีงานใหม่", en: "New task" },
  "task.assigned": { th: "มีการมอบหมายงาน", en: "Task assigned" },
  "task.commented": { th: "มีความคิดเห็นใหม่", en: "New comment" },
  "task.status_changed": { th: "สถานะงานเปลี่ยน", en: "Task status changed" },
  "task.priority_changed": { th: "ความสำคัญของงานเปลี่ยน", en: "Task priority changed" },
  "task.due_soon": { th: "งานใกล้ครบกำหนด", en: "Task due soon" },
  "task.overdue": { th: "งานเลยกำหนด", en: "Task overdue" },
};

/**
 * Posts one Discord message. Re-checked at send time: the destination is still enabled, the task still exists and
 * still belongs to the destination's team/project. By default the message carries NO task title (only the
 * destination's own name, the event kind and a link that requires sign-in); titles are included only when an
 * administrator explicitly enabled `includeDetails` for that destination.
 */
export const discordSend: JobHandler = async (ctx, job) => {
  const orgId = job.orgId;
  const { destinationId, taskId, event } = job.payload as { destinationId?: string; taskId?: string; event?: string };
  if (!orgId || !destinationId || !taskId || !event) throw new PermanentFailure("MalformedJob");

  const prepared = await withWorkerOrg(ctx.db, orgId, async (tx) => {
    const [d] = await tx.select().from(integrationDestinations).where(and(eq(integrationDestinations.orgId, orgId), eq(integrationDestinations.id, destinationId)));
    if (!d || d.deletedAt || !d.enabled) return { skip: "destination_unavailable" as const };
    if (!d.events.includes(event)) return { skip: "event_not_subscribed" as const };
    const [task] = await tx.select().from(tasks).where(and(eq(tasks.orgId, orgId), eq(tasks.id, taskId), isNull(tasks.deletedAt)));
    if (!task) return { skip: "task_gone" as const };
    const inScope = d.projectId
      ? d.projectId === task.projectId
      : ((await tx.execute(sql`select 1 from ${projectTeams} where ${projectTeams.orgId} = ${orgId} and ${projectTeams.projectId} = ${task.projectId} and ${projectTeams.teamId} = ${d.teamId} limit 1`)) as unknown as { rows: unknown[] }).rows.length > 0;
    if (!inScope) return { skip: "out_of_scope" as const };
    const label = (LABEL[event] ?? LABEL["task.status_changed"]!)[DEFAULT_LOCALE];
    const link = `${ctx.appUrl}/o/${orgId}/tasks/${task.id}`;
    const body = d.includeDetails
      ? `🔔 [${plain(d.name, 60)}] ${label}: ${plain(task.title)} (${t(DEFAULT_LOCALE, `status.${task.status}` as never)})\n${link}`
      : `🔔 [${plain(d.name, 60)}] ${label}\n${link}`;
    return { url: decryptSecret(d.webhookCiphertext, ctx.encryptionKeys, `dest:${d.id}`), body };
  });

  if ("skip" in prepared) {
    await withWorkerOrg(ctx.db, orgId, (tx) => tx.insert(deliveryAttempts).values({ orgId, channel: "discord", subjectId: destinationId, status: "skipped", detail: prepared.skip }));
    return;
  }
  if (!parseWebhookUrl(prepared.url).ok) throw new PermanentFailure("InvalidWebhook");

  const result = await postWebhook(ctx.fetchImpl, prepared.url, prepared.body);
  const record = (status: "sent" | "failed", detail: string | null, patch: Record<string, unknown>) =>
    withWorkerOrg(ctx.db, orgId, async (tx) => {
      await tx.insert(deliveryAttempts).values({ orgId, channel: "discord", subjectId: destinationId, status, detail });
      await tx.update(integrationDestinations).set(patch).where(and(eq(integrationDestinations.orgId, orgId), eq(integrationDestinations.id, destinationId)));
    });

  if (result.status === "sent") {
    await record("sent", null, { consecutiveFailures: 0, lastStatus: "sent", lastDeliveryAt: ctx.now() });
    return;
  }
  if (result.status === "rate_limited") {
    await record("failed", "rate_limited", { lastStatus: "rate_limited" });
    throw new Deferred(new Date(ctx.now().getTime() + result.retryAfterMs), "discord_rate_limited");
  }
  if (result.status === "invalid") {
    await record("failed", "invalid_webhook", { enabled: false, disabledReason: "invalid_webhook", lastStatus: "invalid_webhook" });
    throw new PermanentFailure("InvalidWebhook");
  }
  // transient or server-side failure
  await withWorkerOrg(ctx.db, orgId, async (tx) => {
    await tx.insert(deliveryAttempts).values({ orgId, channel: "discord", subjectId: destinationId, status: "failed", detail: result.retryable ? "retryable" : "rejected" });
    const [row] = await tx.update(integrationDestinations).set({ consecutiveFailures: sql`${integrationDestinations.consecutiveFailures} + 1`, lastStatus: "error" }).where(and(eq(integrationDestinations.orgId, orgId), eq(integrationDestinations.id, destinationId))).returning({ n: integrationDestinations.consecutiveFailures });
    if (row && row.n >= MAX_CONSECUTIVE_FAILURES) await tx.update(integrationDestinations).set({ enabled: false, disabledReason: "too_many_failures" }).where(eq(integrationDestinations.id, destinationId));
  });
  if (!result.retryable) throw new PermanentFailure("DiscordRejected");
  throw Object.assign(new Error("DiscordUnavailable"), { status: 502 });
};
