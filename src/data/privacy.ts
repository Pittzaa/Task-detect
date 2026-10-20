import { verifyPassword } from "better-auth/crypto";
import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  attachments, auditLogs, authAccounts, authSessions, authTwoFactor, authVerifications, calendarConnections, comments, digestLog, memberships, notificationPrefs,
  notificationSettings, notifications, oauthStates, organizations, projects, roleAssignments, roles, savedViews, taskActivity, taskAssignees, tasks, users,
} from "@/db/schema";
import { AppError, conflict, validation } from "@/lib/errors";
import { enqueue } from "@/jobs/queue";
import { installationBrand } from "@/server/brand";
import { isOrgAdmin, listMyMemberships, lockOrgAdmins, otherOrgAdmins, setCtx, voidInvitationsOf } from "./account";
import { accessibleProjectIds } from "./scope";
import { withTenant } from "./tenant";

/** Shown in place of the person's name everywhere their (kept) work is attributed to them. */
export const ERASED_NAME = "ผู้ใช้ที่ถูกลบ (Deleted user)";
export const ERASED_DOMAIN = "erased.invalid";
/** A sign-in older than this is not enough to erase an account that has no password to re-enter. */
export const FRESH_SIGN_IN_MS = 15 * 60 * 1000;

const CAP = 5000;

// ---------------------------------------------------------------------------------------------
// Export: everything the system holds about the signed-in user that they are allowed to see
// ---------------------------------------------------------------------------------------------

export interface OrgExport {
  organization: { id: string; name: string };
  roles: { role: string; scope: string }[];
  /** Work created by or assigned to the user, limited to what they can still open. */
  tasks: Record<string, unknown>[];
  /** Items attributed to the user that they can no longer open (for example after losing access to a project). Counted, not listed. */
  tasksNotShown: number;
  comments: Record<string, unknown>[];
  attachments: Record<string, unknown>[];
  activity: Record<string, unknown>[];
  auditTrail: Record<string, unknown>[];
  notifications: Record<string, unknown>[];
  notificationSettings: Record<string, unknown>[];
  notificationPreferences: Record<string, unknown> | null;
  savedViews: Record<string, unknown>[];
  calendar: { connected: boolean; status?: string; lastSyncAt?: Date | null };
  truncated: boolean;
}

export interface MyDataExport {
  generatedAt: string;
  about: string;
  profile: Record<string, unknown>;
  signIn: { sessions: Record<string, unknown>[]; providers: string[]; twoFactorEnabled: boolean };
  memberships: { organization: string | null; status: string }[];
  organizations: OrgExport[];
}

const about = (app: string) =>
  `Personal data held about you by this ${app}. Included: your profile, sign-in history, memberships and, for each organization you belong to, the work you created or are assigned to, your comments, attachment records (file names and sizes, not the files), activity and audit entries about your own actions, notifications, settings and saved views. ` +
  "Not included: credentials (password hashes, two-factor secrets, session tokens), other people's data, and work you can no longer open (it is counted). The organization, not you, owns shared work records; see docs/RETENTION.md.";

async function exportOrg(db: Db, userId: string, orgId: string): Promise<OrgExport> {
  return withTenant(db, { userId, orgId }, async (s) => {
    const tx = s.tx;
    let truncated = false;
    const cap = <T>(rows: T[]): T[] => { if (rows.length > CAP) { truncated = true; return rows.slice(0, CAP); } return rows; };

    const [org] = await tx.select({ id: organizations.id, name: organizations.name }).from(organizations).where(eq(organizations.id, orgId));
    const [mine] = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)));
    const assigned = mine
      ? await tx
          .select({ role: roles.key, scope: roleAssignments.scopeType })
          .from(roleAssignments)
          .innerJoin(roles, eq(roles.id, roleAssignments.roleId))
          .where(and(eq(roleAssignments.orgId, orgId), eq(roleAssignments.membershipId, mine.id)))
      : [];

    // Work: authored or assigned, and only where the user can still read the project.
    const readable = await accessibleProjectIds(s, "task.read");
    const involved = or(
      eq(tasks.createdBy, userId),
      eq(tasks.primaryAssigneeId, userId),
      sql`exists (select 1 from task_assignees a where a.task_id = ${tasks.id} and a.org_id = ${tasks.orgId} and a.user_id = ${userId})`,
    )!;
    // A deleted project is readable by nobody, an administrator included, so its work is left out for everyone alike.
    const inLiveProject = sql`exists (select 1 from projects pr where pr.org_id = ${tasks.orgId} and pr.id = ${tasks.projectId} and pr.deleted_at is null)`;
    const canRead = readable === "all" ? inLiveProject : and(inArray(tasks.projectId, readable.length ? readable : ["00000000-0000-0000-0000-000000000000"]), inLiveProject);
    const allInvolved = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.orgId, orgId), involved));
    const taskRows = await tx
      .select({
        id: tasks.id, project: projects.name, title: tasks.title, description: tasks.description, status: tasks.status, priority: tasks.priority,
        startDate: tasks.startDate, dueDate: tasks.dueDate, createdAt: tasks.createdAt, completedAt: tasks.completedAt, deletedAt: tasks.deletedAt,
        createdByMe: sql<boolean>`${tasks.createdBy} = ${userId}`, primaryAssigneeIsMe: sql<boolean>`${tasks.primaryAssigneeId} = ${userId}`,
      })
      .from(tasks)
      .innerJoin(projects, and(eq(projects.orgId, tasks.orgId), eq(projects.id, tasks.projectId)))
      .where(and(eq(tasks.orgId, orgId), involved, canRead))
      .orderBy(desc(tasks.createdAt))
      .limit(CAP + 1);

    const commentRows = await tx
      .select({ id: comments.id, task: tasks.title, body: comments.body, createdAt: comments.createdAt, editedAt: comments.editedAt, deletedAt: comments.deletedAt })
      .from(comments)
      .innerJoin(tasks, and(eq(tasks.orgId, comments.orgId), eq(tasks.id, comments.taskId)))
      .where(and(eq(comments.orgId, orgId), eq(comments.authorId, userId), canRead))
      .orderBy(desc(comments.createdAt))
      .limit(CAP + 1);
    const attachmentRows = await tx
      .select({ id: attachments.id, task: tasks.title, filename: attachments.filename, contentType: attachments.contentType, sizeBytes: attachments.sizeBytes, sha256: attachments.sha256, createdAt: attachments.createdAt, deletedAt: attachments.deletedAt })
      .from(attachments)
      .innerJoin(tasks, and(eq(tasks.orgId, attachments.orgId), eq(tasks.id, attachments.taskId)))
      .where(and(eq(attachments.orgId, orgId), eq(attachments.uploadedBy, userId), canRead))
      .orderBy(desc(attachments.createdAt))
      .limit(CAP + 1);
    const activityRows = await tx
      .select({ type: taskActivity.type, task: tasks.title, at: taskActivity.createdAt })
      .from(taskActivity)
      .innerJoin(tasks, and(eq(tasks.orgId, taskActivity.orgId), eq(tasks.id, taskActivity.taskId)))
      .where(and(eq(taskActivity.orgId, orgId), eq(taskActivity.actorId, userId), canRead))
      .orderBy(desc(taskActivity.createdAt))
      .limit(CAP + 1);
    // The audit trail of the user's own actions (metadata left out: it can describe other people).
    const auditRows = await tx
      .select({ action: auditLogs.action, targetType: auditLogs.targetType, at: auditLogs.createdAt })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, orgId), eq(auditLogs.actorUserId, userId)))
      .orderBy(desc(auditLogs.createdAt))
      .limit(CAP + 1);
    const notificationRows = await tx
      .select({ type: notifications.type, params: notifications.params, createdAt: notifications.createdAt, readAt: notifications.readAt })
      .from(notifications)
      .where(and(eq(notifications.orgId, orgId), eq(notifications.userId, userId)))
      .orderBy(desc(notifications.createdAt))
      .limit(CAP + 1);
    const settingRows = await tx
      .select({ channel: notificationSettings.channel, event: notificationSettings.event, enabled: notificationSettings.enabled })
      .from(notificationSettings)
      .where(and(eq(notificationSettings.orgId, orgId), eq(notificationSettings.userId, userId)));
    const [prefs] = await tx
      .select({ digest: notificationPrefs.digest, quietStart: notificationPrefs.quietStart, quietEnd: notificationPrefs.quietEnd })
      .from(notificationPrefs)
      .where(and(eq(notificationPrefs.orgId, orgId), eq(notificationPrefs.userId, userId)));
    const viewRows = await tx
      .select({ name: savedViews.name, scope: savedViews.scope, kind: savedViews.kind, filter: savedViews.filter, createdAt: savedViews.createdAt })
      .from(savedViews)
      .where(and(eq(savedViews.orgId, orgId), eq(savedViews.ownerId, userId), sql`${savedViews.deletedAt} is null`));
    const [cal] = await tx
      .select({ status: calendarConnections.status, lastSyncAt: calendarConnections.lastSyncAt })
      .from(calendarConnections)
      .where(and(eq(calendarConnections.orgId, orgId), eq(calendarConnections.userId, userId)));

    return {
      organization: { id: org?.id ?? orgId, name: org?.name ?? "" },
      roles: assigned.map((a) => ({ role: a.role, scope: a.scope })),
      tasks: cap(taskRows),
      tasksNotShown: Math.max(0, allInvolved.length - taskRows.length),
      comments: cap(commentRows),
      attachments: cap(attachmentRows),
      activity: cap(activityRows),
      auditTrail: cap(auditRows),
      notifications: cap(notificationRows),
      notificationSettings: settingRows,
      notificationPreferences: prefs ?? null,
      savedViews: viewRows,
      calendar: cal ? { connected: true, status: cal.status, lastSyncAt: cal.lastSyncAt } : { connected: false },
      truncated,
    };
  });
}

export async function exportMyData(db: Db, userId: string, now = new Date()): Promise<MyDataExport> {
  const global = await db.transaction(async (tx) => {
    await setCtx(tx, { userId });
    const [u] = await tx
      .select({ id: users.id, email: users.email, name: users.name, emailVerified: users.emailVerified, locale: users.locale, timezone: users.timezone, createdAt: users.createdAt, twoFactorEnabled: users.twoFactorEnabled })
      .from(users)
      .where(eq(users.id, userId));
    const sessions = await tx
      .select({ createdAt: authSessions.createdAt, expiresAt: authSessions.expiresAt, ipAddress: authSessions.ipAddress, userAgent: authSessions.userAgent })
      .from(authSessions)
      .where(eq(authSessions.userId, userId))
      .orderBy(desc(authSessions.createdAt))
      .limit(100);
    const providers = await tx.select({ providerId: authAccounts.providerId }).from(authAccounts).where(eq(authAccounts.userId, userId));
    return { u, sessions, providers };
  });
  if (!global.u) throw new AppError("NOT_FOUND", "Not found", 404);

  const mine = await listMyMemberships(db, userId);
  const orgs: OrgExport[] = [];
  for (const m of mine) {
    if (m.status === "approved" && m.org) orgs.push(await exportOrg(db, userId, m.org.id));
  }
  return {
    generatedAt: now.toISOString(),
    about: about(await installationBrand(db)),
    profile: { ...global.u, twoFactorEnabled: undefined },
    signIn: { sessions: global.sessions, providers: [...new Set(global.providers.map((p) => p.providerId))], twoFactorEnabled: !!global.u.twoFactorEnabled },
    memberships: mine.map((m) => ({ organization: m.org?.name ?? null, status: m.status })),
    organizations: orgs,
  };
}

// ---------------------------------------------------------------------------------------------
// Erasure
// ---------------------------------------------------------------------------------------------

export interface EraseInput {
  /** The account's own e-mail address, typed by the user. */
  confirmEmail: string;
  /** Required whenever the account has a password. */
  password?: string;
  /** Allow leaving organizations in which this user is the only member (nobody could administer them afterwards). */
  abandonOrganizations?: boolean;
  sessionCreatedAt: Date;
}

/**
 * Removes the person, keeps the organizations' records.
 *
 * Deleted: sign-in credentials, sessions, two-factor secrets, calendar link (and the events we created, by a background job),
 * notification data, saved views, role assignments and assignee links, and the e-mail address / name / image on the profile.
 * Kept: work, comments, attachments and audit entries the person authored — they belong to the organization's records — now
 * attributed to "Deleted user". Memberships stay as `revoked` rows so every foreign key still holds.
 * The whole operation is one transaction: if any organization would be left without an administrator, nothing changes.
 */
export async function eraseMyAccount(db: Db, user: { id: string; email: string }, input: EraseInput, now = new Date()): Promise<{ organizations: number }> {
  if (input.confirmEmail.trim().toLowerCase() !== user.email.trim().toLowerCase()) throw validation("Type your e-mail address exactly to confirm");

  const [credential] = await db.select({ password: authAccounts.password }).from(authAccounts).where(and(eq(authAccounts.userId, user.id), eq(authAccounts.providerId, "credential")));
  if (credential?.password) {
    // A wrong password is a VALIDATION error, not 401/403: those would make the browser think the session ended.
    if (!input.password || !(await verifyPassword({ hash: credential.password, password: input.password }))) throw validation("The password is incorrect");
  } else if (now.getTime() - input.sessionCreatedAt.getTime() > FRESH_SIGN_IN_MS) {
    throw conflict("Sign out and sign in again, then erase the account within 15 minutes");
  }

  return eraseAccount(db, user, { abandonOrganizations: input.abandonOrganizations }, now);
}

/**
 * The erasure itself, after the caller has proven who is asking (the person, with their password, or an operator on the command line).
 * Never exposed over HTTP without that proof.
 */
export async function eraseAccount(db: Db, user: { id: string; email: string }, o: { abandonOrganizations?: boolean }, now = new Date()): Promise<{ organizations: number }> {
  const [self] = await db.select({ isPlatformAdmin: users.isPlatformAdmin }).from(users).where(eq(users.id, user.id));
  if (!self) throw new AppError("NOT_FOUND", "Not found", 404);
  if (self.isPlatformAdmin) throw conflict("Platform administrators cannot erase their account. An operator must remove that role first.");

  return db.transaction(async (tx) => {
    await setCtx(tx, { userId: user.id });
    const mine = await tx.select({ id: memberships.id, orgId: memberships.orgId, status: memberships.status }).from(memberships).where(eq(memberships.userId, user.id)).orderBy(memberships.orgId);

    for (const m of mine) {
      await setCtx(tx, { userId: user.id, orgId: m.orgId });
      await lockOrgAdmins(tx, m.orgId);
      const [org] = await tx.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, m.orgId));
      const label = org?.name ?? "an organization";

      if (m.status === "approved") {
        const others = await tx.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.orgId, m.orgId), eq(memberships.status, "approved"), ne(memberships.id, m.id))).limit(1);
        if (await isOrgAdmin(tx, m.id)) {
          if ((await otherOrgAdmins(tx, m.orgId, m.id)) === 0) {
            if (others.length > 0) throw conflict(`You are the only administrator of "${label}". Make someone else an administrator before erasing your account.`);
            if (!o.abandonOrganizations) {
              throw new AppError("CONFLICT", `You are the only member of "${label}". Erasing your account leaves it without anyone who can open it.`, 409, undefined, { needsAbandon: true });
            }
          }
        }
      }

      // Calendar: the cleanup job deletes the events we created in Google and revokes the token, then removes the connection.
      const [conn] = await tx.select({ id: calendarConnections.id }).from(calendarConnections).where(and(eq(calendarConnections.orgId, m.orgId), eq(calendarConnections.userId, user.id)));
      if (conn) {
        await tx.update(calendarConnections).set({ status: "disconnecting" }).where(eq(calendarConnections.id, conn.id));
        await enqueue(tx, { kind: "calendar.cleanup", orgId: m.orgId, payload: { connectionId: conn.id, deleteEvents: true }, maxAttempts: 5 });
      }

      // Work stays, but is no longer assigned to a person who is gone.
      await tx.update(tasks).set({ primaryAssigneeId: null, version: sql`${tasks.version} + 1`, updatedAt: now }).where(and(eq(tasks.orgId, m.orgId), eq(tasks.primaryAssigneeId, user.id)));
      await tx.delete(taskAssignees).where(and(eq(taskAssignees.orgId, m.orgId), eq(taskAssignees.userId, user.id)));
      await tx.delete(roleAssignments).where(and(eq(roleAssignments.orgId, m.orgId), eq(roleAssignments.membershipId, m.id)));
      await tx.delete(notifications).where(and(eq(notifications.orgId, m.orgId), eq(notifications.userId, user.id)));
      await tx.delete(notificationSettings).where(and(eq(notificationSettings.orgId, m.orgId), eq(notificationSettings.userId, user.id)));
      await tx.delete(notificationPrefs).where(and(eq(notificationPrefs.orgId, m.orgId), eq(notificationPrefs.userId, user.id)));
      await tx.delete(digestLog).where(and(eq(digestLog.orgId, m.orgId), eq(digestLog.userId, user.id)));
      await tx.delete(savedViews).where(and(eq(savedViews.orgId, m.orgId), eq(savedViews.ownerId, user.id)));
      await tx.update(memberships).set({ status: "revoked" }).where(eq(memberships.id, m.id));
      await voidInvitationsOf(tx, m.orgId, { userId: user.id, email: user.email });
      await tx.insert(auditLogs).values({ orgId: m.orgId, actorUserId: user.id, action: "account.erased", targetType: "user", targetId: user.id, metadata: { previousStatus: m.status, abandoned: m.status === "approved" && !!o.abandonOrganizations } });
    }

    // Not tenant data: run with no organization selected.
    await setCtx(tx, { userId: user.id });
    await tx.delete(oauthStates).where(eq(oauthStates.userId, user.id));
    await tx.delete(authSessions).where(eq(authSessions.userId, user.id));
    await tx.delete(authAccounts).where(eq(authAccounts.userId, user.id));
    await tx.delete(authTwoFactor).where(eq(authTwoFactor.userId, user.id));
    await tx.delete(authVerifications).where(or(eq(authVerifications.identifier, user.email), eq(authVerifications.identifier, user.email.toLowerCase()))!);
    await tx
      .update(users)
      .set({ email: `erased-${user.id}@${ERASED_DOMAIN}`, name: ERASED_NAME, image: null, emailVerified: false, twoFactorEnabled: false, deletedAt: now, updatedAt: now })
      .where(eq(users.id, user.id));
    return { organizations: mine.length };
  });
}
