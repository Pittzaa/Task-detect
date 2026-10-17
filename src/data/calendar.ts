import { createHash, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { auditLogs, calendarConnections, oauthStates } from "@/db/schema";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "@/lib/crypto";
import { conflict, notFound, validation } from "@/lib/errors";
import { CALENDAR_SCOPE, GoogleError, type GoogleClient } from "@/integrations/google-calendar";
import { enqueue } from "@/jobs/queue";
import { consumeRateLimit } from "@/server/rate-limit";
import { withTenant, type TenantSession } from "./tenant";
import type { SecretDeps } from "./integrations";

const STATE_TTL_MS = 10 * 60 * 1000;

async function userCtx(tx: Tx, userId: string) {
  await tx.execute(sql`select set_config('app.user_id', ${userId}, true), set_config('app.org_id', '', true)`);
}

/** Step 1: create a one-time state + PKCE verifier and return the Google consent URL. */
export async function startCalendarConnect(db: Db, auth: { userId: string; orgId: string }, google: GoogleClient, deps: SecretDeps): Promise<{ url: string }> {
  return withTenant(db, auth, async (s) => {
    s.requireAny("task.read");
    await consumeRateLimit(s.tx as unknown as Db, `cal-connect:${s.userId}`, 3600, 10);
    const state = randomToken(32);
    const verifier = randomToken(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const stateHash = sha256Hex(state);
    await s.tx.insert(oauthStates).values({
      stateHash, userId: s.userId, orgId: s.orgId, expiresAt: new Date(Date.now() + STATE_TTL_MS),
      codeVerifierCiphertext: encryptSecret(verifier, deps.encryptionKeys[0]!, `oauth:${stateHash}`),
    });
    return { url: google.authorizeUrl(state, challenge) };
  });
}

/**
 * Step 2 (the redirect back from Google). The state must belong to the signed-in user, be unexpired and unused;
 * it is consumed atomically so a replayed callback fails. Returns the organization to send the user back to.
 */
export async function finishCalendarConnect(db: Db, userId: string, input: { code: string; state: string }, google: GoogleClient, deps: SecretDeps): Promise<{ orgId: string }> {
  const stateHash = sha256Hex(input.state);
  const claimed = await db.transaction(async (tx) => {
    await userCtx(tx, userId);
    const [row] = await tx.delete(oauthStates).where(and(eq(oauthStates.stateHash, stateHash), eq(oauthStates.userId, userId))).returning();
    return row;
  });
  if (!claimed || claimed.expiresAt < new Date()) throw notFound();
  const verifier = decryptSecret(claimed.codeVerifierCiphertext, deps.encryptionKeys, `oauth:${stateHash}`);

  let tokens: Awaited<ReturnType<GoogleClient["exchangeCode"]>>;
  try {
    tokens = await google.exchangeCode(input.code, verifier);
  } catch (e) {
    if (e instanceof GoogleError) throw validation("Google rejected the authorization");
    throw e;
  }
  if (!tokens.scope.split(" ").includes(CALENDAR_SCOPE)) throw validation("Calendar access was not granted");

  await withTenant(db, { userId, orgId: claimed.orgId }, async (s) => {
    s.requireAny("task.read");
    const id = randomUUID();
    const ciphertext = encryptSecret(tokens.refreshToken, deps.encryptionKeys[0]!, `cal:${id}`);
    const [existing] = await s.tx.select().from(calendarConnections).where(and(eq(calendarConnections.orgId, s.orgId), eq(calendarConnections.userId, s.userId)));
    let connectionId: string;
    if (existing) {
      // Reconnecting keeps the connection id (so event ids stay stable). The ciphertext is bound to that id.
      connectionId = existing.id;
      await s.tx.update(calendarConnections).set({ refreshTokenCiphertext: encryptSecret(tokens.refreshToken, deps.encryptionKeys[0]!, `cal:${existing.id}`), scope: tokens.scope, status: "active", lastError: null }).where(eq(calendarConnections.id, existing.id));
    } else {
      connectionId = id;
      await s.tx.insert(calendarConnections).values({ id, orgId: s.orgId, userId: s.userId, refreshTokenCiphertext: ciphertext, scope: tokens.scope });
    }
    await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "calendar.connect", targetType: "calendar_connection", targetId: connectionId });
    await enqueue(s.tx, { kind: "calendar.resync", orgId: s.orgId, payload: { connectionId }, maxAttempts: 4 });
  });
  return { orgId: claimed.orgId };
}

/** The caller's own connection status. Tokens are never returned. */
export async function calendarStatus(s: TenantSession) {
  const [conn] = await s.tx.select().from(calendarConnections).where(and(eq(calendarConnections.orgId, s.orgId), eq(calendarConnections.userId, s.userId)));
  if (!conn) return { connected: false as const };
  const res = (await s.tx.execute(sql`select count(*)::int as linked, count(*) filter (where failures > 0)::int as failing from calendar_event_links where connection_id = ${conn.id}`)) as unknown as { rows: { linked: number; failing: number }[] };
  const counts = res.rows[0];
  return { connected: true as const, status: conn.status, lastSyncAt: conn.lastSyncAt, lastError: conn.lastError, linkedEvents: counts?.linked ?? 0, failingEvents: counts?.failing ?? 0 };
}

export async function disconnectCalendar(s: TenantSession, o: { deleteEvents: boolean }) {
  const [conn] = await s.tx.select().from(calendarConnections).where(and(eq(calendarConnections.orgId, s.orgId), eq(calendarConnections.userId, s.userId)));
  if (!conn) throw notFound();
  await s.tx.update(calendarConnections).set({ status: "disconnecting" }).where(eq(calendarConnections.id, conn.id));
  await enqueue(s.tx, { kind: "calendar.cleanup", orgId: s.orgId, payload: { connectionId: conn.id, deleteEvents: o.deleteEvents }, maxAttempts: 5 });
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "calendar.disconnect", targetType: "calendar_connection", targetId: conn.id, metadata: { deleteEvents: o.deleteEvents } });
}

export async function requestResync(s: TenantSession) {
  const [conn] = await s.tx.select().from(calendarConnections).where(and(eq(calendarConnections.orgId, s.orgId), eq(calendarConnections.userId, s.userId)));
  if (!conn) throw notFound();
  if (conn.status !== "active") throw conflict("Reconnect your calendar first");
  await consumeRateLimit(s.tx as unknown as Db, `cal-resync:${s.userId}`, 3600, 6);
  await enqueue(s.tx, { kind: "calendar.resync", orgId: s.orgId, payload: { connectionId: conn.id }, maxAttempts: 4 });
}

