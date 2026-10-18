import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { auditLogs, integrationDestinations, projects, teams } from "@/db/schema";
import { DISCORD_EVENTS } from "@/domain/notifications";
import { encryptSecret } from "@/lib/crypto";
import { notFound, validation } from "@/lib/errors";
import { parseWebhookUrl } from "@/integrations/discord";
import type { TenantSession } from "./tenant";

export interface SecretDeps {
  /** Current key first. */
  encryptionKeys: string[];
}

const eventsOk = (e: string[]) => e.length > 0 && e.length <= DISCORD_EVENTS.length && e.every((x) => (DISCORD_EVENTS as readonly string[]).includes(x));

function parseUrl(raw: string) {
  const r = parseWebhookUrl(raw.trim());
  if (!r.ok) throw validation("Invalid Discord webhook URL");
  return r;
}

export interface DestinationInput {
  name: string;
  webhookUrl: string;
  teamId?: string | null;
  projectId?: string | null;
  events: string[];
  includeDetails?: boolean;
}

/** The webhook URL is write-only: it is encrypted on save and never returned by any API afterwards. */
export async function createDestination(s: TenantSession, deps: SecretDeps, input: DestinationInput) {
  s.require("org.manage_integrations");
  const name = input.name.trim();
  if (!name || name.length > 80) throw validation("Name must be 1-80 characters");
  if (!!input.teamId === !!input.projectId) throw validation("Choose exactly one team or project");
  if (!eventsOk(input.events)) throw validation("Choose at least one valid event");
  const { hint } = parseUrl(input.webhookUrl);
  if (input.teamId) {
    const [t] = await s.tx.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, s.orgId), eq(teams.id, input.teamId), isNull(teams.deletedAt)));
    if (!t) throw notFound();
  } else {
    const [p] = await s.tx.select({ id: projects.id }).from(projects).where(and(eq(projects.orgId, s.orgId), eq(projects.id, input.projectId!), isNull(projects.deletedAt)));
    if (!p) throw notFound();
  }
  const id = randomUUID();
  await s.tx.insert(integrationDestinations).values({
    id, orgId: s.orgId, teamId: input.teamId ?? null, projectId: input.projectId ?? null, name, webhookHint: hint, events: [...new Set(input.events)],
    includeDetails: input.includeDetails ?? false, webhookCiphertext: encryptSecret(input.webhookUrl.trim(), deps.encryptionKeys[0]!, `dest:${id}`), createdBy: s.userId,
  });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "integration.create", targetType: "destination", targetId: id, metadata: { kind: "discord", includeDetails: input.includeDetails ?? false } });
  return { id };
}

export async function listDestinations(s: TenantSession) {
  s.require("org.manage_integrations");
  const rows = await s.tx
    .select({
      id: integrationDestinations.id, name: integrationDestinations.name, teamId: integrationDestinations.teamId, projectId: integrationDestinations.projectId,
      events: integrationDestinations.events, includeDetails: integrationDestinations.includeDetails, enabled: integrationDestinations.enabled,
      disabledReason: integrationDestinations.disabledReason, lastStatus: integrationDestinations.lastStatus, lastDeliveryAt: integrationDestinations.lastDeliveryAt,
      consecutiveFailures: integrationDestinations.consecutiveFailures, hint: integrationDestinations.webhookHint, rotatedAt: integrationDestinations.rotatedAt,
    })
    .from(integrationDestinations)
    .where(and(eq(integrationDestinations.orgId, s.orgId), isNull(integrationDestinations.deletedAt)))
    .orderBy(asc(integrationDestinations.name))
    .limit(200);
  return rows.map(({ hint, ...r }) => ({ ...r, webhook: `…${hint}` }));
}

export async function updateDestination(s: TenantSession, id: string, patch: { name?: string; events?: string[]; includeDetails?: boolean; enabled?: boolean }) {
  s.require("org.manage_integrations");
  const set: Partial<typeof integrationDestinations.$inferInsert> = {};
  if (patch.name !== undefined) {
    const n = patch.name.trim();
    if (!n || n.length > 80) throw validation("Name must be 1-80 characters");
    set.name = n;
  }
  if (patch.events !== undefined) {
    if (!eventsOk(patch.events)) throw validation("Choose at least one valid event");
    set.events = [...new Set(patch.events)];
  }
  if (patch.includeDetails !== undefined) set.includeDetails = patch.includeDetails;
  if (patch.enabled !== undefined) {
    set.enabled = patch.enabled;
    if (patch.enabled) { set.disabledReason = null; set.consecutiveFailures = 0; }
    else set.disabledReason = "disabled_by_admin";
  }
  if (!Object.keys(set).length) return;
  const res = await s.tx.update(integrationDestinations).set(set).where(and(eq(integrationDestinations.orgId, s.orgId), eq(integrationDestinations.id, id), isNull(integrationDestinations.deletedAt))).returning({ id: integrationDestinations.id });
  if (!res[0]) throw notFound();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "integration.update", targetType: "destination", targetId: id, metadata: { fields: Object.keys(set) } });
}

/** Replaces the secret (for example after it leaked or was regenerated in Discord) and re-enables delivery. */
export async function rotateDestination(s: TenantSession, deps: SecretDeps, id: string, webhookUrl: string) {
  s.require("org.manage_integrations");
  const { hint } = parseUrl(webhookUrl);
  const res = await s.tx
    .update(integrationDestinations)
    .set({ webhookCiphertext: encryptSecret(webhookUrl.trim(), deps.encryptionKeys[0]!, `dest:${id}`), webhookHint: hint, rotatedAt: new Date(), enabled: true, disabledReason: null, consecutiveFailures: 0 })
    .where(and(eq(integrationDestinations.orgId, s.orgId), eq(integrationDestinations.id, id), isNull(integrationDestinations.deletedAt)))
    .returning({ id: integrationDestinations.id });
  if (!res[0]) throw notFound();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "integration.rotate", targetType: "destination", targetId: id });
}

/** Stored in place of the encrypted webhook URL when a destination is deleted: the secret is gone immediately, not after the retention period. */
const DESTROYED_SECRET = "destroyed";

export async function deleteDestination(s: TenantSession, id: string) {
  s.require("org.manage_integrations");
  const res = await s.tx.update(integrationDestinations).set({ deletedAt: new Date(), enabled: false, webhookCiphertext: DESTROYED_SECRET }).where(and(eq(integrationDestinations.orgId, s.orgId), eq(integrationDestinations.id, id), isNull(integrationDestinations.deletedAt))).returning({ id: integrationDestinations.id });
  if (!res[0]) throw notFound();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "integration.delete", targetType: "destination", targetId: id });
}

/** Health of this organization's background work, for the admin integrations page. Contains counts and error classes only. */
export async function jobHealth(s: TenantSession) {
  s.require("org.manage_integrations");
  const res = (await s.tx.execute(sql`
    select kind,
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'dead')::int as dead,
      max(last_error) filter (where status in ('dead','pending') and last_error is not null) as last_error
    from jobs where org_id = ${s.orgId} and (status in ('pending','dead')) group by kind order by kind`)) as unknown as { rows: { kind: string; pending: number; dead: number; last_error: string | null }[] };
  return { kinds: res.rows.map((r) => ({ kind: r.kind, pending: r.pending, dead: r.dead, lastError: r.last_error })) };
}

