import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { notificationPrefs, notificationSettings, notifications, users } from "@/db/schema";
import { CHANNELS, NOTIFICATION_TYPES, defaultEnabled, isHHMM, isNotificationType, type Channel } from "@/domain/notifications";
import { DEFAULT_LOCALE, isLocale } from "@/i18n";
import { renderNotification } from "@/jobs/notify";
import { validation } from "@/lib/errors";
import type { TenantSession } from "./tenant";

async function myLocale(s: TenantSession) {
  const [u] = await s.tx.select({ locale: users.locale }).from(users).where(eq(users.id, s.userId));
  return u && isLocale(u.locale) ? u.locale : DEFAULT_LOCALE;
}

/**
 * Lists the caller's notifications, rendered in their language. Text is produced *now*: if they have lost access to
 * a task, the entry is shown as a generic placeholder with no task data.
 */
export async function listNotifications(s: TenantSession, o: { unreadOnly?: boolean; limit?: number; offset?: number } = {}) {
  const limit = Math.min(Math.max(o.limit ?? 30, 1), 100);
  const rows = await s.tx
    .select()
    .from(notifications)
    .where(and(eq(notifications.orgId, s.orgId), eq(notifications.userId, s.userId), eq(notifications.inApp, true), o.unreadOnly ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(limit + 1)
    .offset(Math.max(o.offset ?? 0, 0));
  const locale = await myLocale(s);
  const items = [];
  for (const n of rows.slice(0, limit)) {
    const r = await renderNotification(s.tx, s.orgId, n, locale);
    items.push({ id: n.id, type: n.type, text: r.text, taskId: r.taskId, visible: r.visible, createdAt: n.createdAt, read: !!n.readAt });
  }
  return { items, hasMore: rows.length > limit };
}

export async function unreadCount(s: TenantSession): Promise<number> {
  const [r] = await s.tx.select({ n: sql<number>`count(*)::int` }).from(notifications).where(and(eq(notifications.orgId, s.orgId), eq(notifications.userId, s.userId), eq(notifications.inApp, true), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

export async function markRead(s: TenantSession, ids: string[] | "all") {
  const base = and(eq(notifications.orgId, s.orgId), eq(notifications.userId, s.userId), isNull(notifications.readAt));
  const where = ids === "all" ? base : and(base, sql`${notifications.id} in (${sql.join(ids.slice(0, 200).map((i) => sql`${i}`), sql`, `)})`);
  if (ids !== "all" && ids.length === 0) return 0;
  const res = await s.tx.update(notifications).set({ readAt: new Date() }).where(where).returning({ id: notifications.id });
  return res.length;
}

export interface SettingsView {
  settings: { channel: Channel; event: string; enabled: boolean; isDefault: boolean }[];
  digest: "off" | "daily" | "weekly";
  quietStart: string | null;
  quietEnd: string | null;
}

export async function getSettings(s: TenantSession): Promise<SettingsView> {
  const rows = await s.tx.select().from(notificationSettings).where(and(eq(notificationSettings.orgId, s.orgId), eq(notificationSettings.userId, s.userId)));
  const [prefs] = await s.tx.select().from(notificationPrefs).where(and(eq(notificationPrefs.orgId, s.orgId), eq(notificationPrefs.userId, s.userId)));
  const settings: SettingsView["settings"] = [];
  for (const channel of CHANNELS) for (const event of NOTIFICATION_TYPES) {
    const row = rows.find((r) => r.channel === channel && r.event === event);
    settings.push({ channel, event, enabled: row ? row.enabled : defaultEnabled(channel, event), isDefault: !row });
  }
  return { settings, digest: prefs?.digest ?? "off", quietStart: prefs?.quietStart ?? null, quietEnd: prefs?.quietEnd ?? null };
}

export async function updateSettings(
  s: TenantSession,
  input: { settings?: { channel: Channel; event: string; enabled: boolean }[]; digest?: "off" | "daily" | "weekly"; quietStart?: string | null; quietEnd?: string | null },
) {
  for (const x of input.settings ?? []) {
    if (!CHANNELS.includes(x.channel) || !isNotificationType(x.event)) throw validation("Unknown notification setting");
    await s.tx
      .insert(notificationSettings)
      .values({ orgId: s.orgId, userId: s.userId, channel: x.channel, event: x.event, enabled: x.enabled })
      .onConflictDoUpdate({ target: [notificationSettings.orgId, notificationSettings.userId, notificationSettings.channel, notificationSettings.event], set: { enabled: x.enabled } });
  }
  if (input.digest !== undefined || input.quietStart !== undefined || input.quietEnd !== undefined) {
    const [cur] = await s.tx.select().from(notificationPrefs).where(and(eq(notificationPrefs.orgId, s.orgId), eq(notificationPrefs.userId, s.userId)));
    const quietStart = input.quietStart !== undefined ? input.quietStart : cur?.quietStart ?? null;
    const quietEnd = input.quietEnd !== undefined ? input.quietEnd : cur?.quietEnd ?? null;
    if ((quietStart === null) !== (quietEnd === null)) throw validation("Quiet hours need both a start and an end");
    if (quietStart !== null && (!isHHMM(quietStart) || !isHHMM(quietEnd!))) throw validation("Quiet hours must be HH:MM");
    const digest = input.digest ?? cur?.digest ?? "off";
    await s.tx.insert(notificationPrefs).values({ orgId: s.orgId, userId: s.userId, digest, quietStart, quietEnd }).onConflictDoUpdate({ target: [notificationPrefs.orgId, notificationPrefs.userId], set: { digest, quietStart, quietEnd } });
  }
}
