import { eq } from "drizzle-orm";
import { auditLogs, organizations } from "@/db/schema";
import { notFound } from "@/lib/errors";
import type { TenantSession } from "./tenant";

/** Organization-wide switches. Only people who may manage settings see or change them. */
export async function getOrgSettings(s: TenantSession) {
  s.require("org.manage_settings");
  const [org] = await s.tx.select({ name: organizations.name, slug: organizations.slug, registrationOpen: organizations.registrationOpen }).from(organizations).where(eq(organizations.id, s.orgId));
  if (!org) throw notFound();
  return org;
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
