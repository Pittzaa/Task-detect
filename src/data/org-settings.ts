import { eq } from "drizzle-orm";
import { auditLogs, organizations } from "@/db/schema";
import { asEmailSchedule, type EmailSchedule } from "@/domain/email-schedule";
import { notFound } from "@/lib/errors";
import type { TenantSession } from "./tenant";

/** Organization-wide switches. Only people who may manage settings see or change them. */
export async function getOrgSettings(s: TenantSession) {
  s.require("org.manage_settings");
  const [org] = await s.tx.select({ name: organizations.name, slug: organizations.slug, registrationOpen: organizations.registrationOpen, autoEmail: organizations.autoEmail, emailSchedule: organizations.emailSchedule }).from(organizations).where(eq(organizations.id, s.orgId));
  if (!org) throw notFound();
  return { ...org, emailSchedule: asEmailSchedule(org.emailSchedule) };
}

/**
 * Opens or closes registration. Closed: nobody new can sign up or ask to join, except an address that already holds a
 * pending invitation. People who are already members are not affected.
 */
export async function setRegistrationOpen(s: TenantSession, open: boolean) {
  s.require("org.manage_settings");
  const res = await s.tx.update(organizations).set({ registrationOpen: open }).where(eq(organizations.id, s.orgId)).returning({ registrationOpen: organizations.registrationOpen });
  if (!res[0]) throw notFound();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: open ? "org.registration_open" : "org.registration_close", targetType: "organization", targetId: s.orgId });
  return res[0];
}

/**
 * Turns automatic e-mail on or off for the organization: notification e-mails sent as soon as the background work runs, and the
 * daily/weekly digests. Off: e-mails wait until an administrator sends them (src/data/notification-emails.ts). Notifications inside the
 * app are not affected. Whether the e-mails then go out within a minute depends on something running the background work regularly.
 */
export async function setAutoEmail(s: TenantSession, on: boolean) {
  s.require("org.manage_settings");
  const res = await s.tx.update(organizations).set({ autoEmail: on }).where(eq(organizations.id, s.orgId)).returning({ autoEmail: organizations.autoEmail });
  if (!res[0]) throw notFound();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: on ? "org.auto_email_on" : "org.auto_email_off", targetType: "organization", targetId: s.orgId });
  return res[0];
}

/**
 * When automatic e-mail goes out: "instant" as soon as the background work runs (own server, or a plan that runs it every minute or faster), "daily" held for
 * 23:00 Thai time (a once-a-day cron such as Vercel Hobby). It only matters while automatic e-mail is on; the administrator's button sends at once in either mode.
 * E-mails already queued keep the time they were queued for.
 */
export async function setEmailSchedule(s: TenantSession, schedule: EmailSchedule) {
  s.require("org.manage_settings");
  const res = await s.tx.update(organizations).set({ emailSchedule: schedule }).where(eq(organizations.id, s.orgId)).returning({ emailSchedule: organizations.emailSchedule });
  if (!res[0]) throw notFound();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: schedule === "daily" ? "org.email_schedule_daily" : "org.email_schedule_instant", targetType: "organization", targetId: s.orgId });
  return res[0];
}
