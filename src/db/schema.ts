import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const membershipStatus = pgEnum("membership_status", ["pending", "approved", "suspended", "revoked"]);
export const scopeType = pgEnum("scope_type", ["organization", "department", "team", "project"]);
export const locale = pgEnum("locale", ["th", "en"]);
export const taskStatus = pgEnum("task_status", ["todo", "progress", "review", "done", "cancelled", "blocked"]);
export const taskPriority = pgEnum("task_priority", ["low", "medium", "high", "urgent"]);

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const deletedAt = () => timestamp("deleted_at", { withTimezone: true });

export const organizations = pgTable("organizations", {
  id: id(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: createdAt(),
  deletedAt: deletedAt(),
});

export const users = pgTable(
  "users",
  {
    id: id(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    twoFactorEnabled: boolean("two_factor_enabled").default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    locale: locale("locale").notNull().default("th"),
    // IANA time zone name, validated in the application layer.
    timezone: text("timezone").notNull().default("Asia/Bangkok"),
    // Platform-level `superadmin`. Not an organization role; see docs/RBAC.md.
    isPlatformAdmin: boolean("is_platform_admin").notNull().default(false),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex("users_email_lower_uq").on(sql`lower(${t.email})`)],
);

export const memberships = pgTable(
  "memberships",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    userId: uuid("user_id").notNull().references(() => users.id),
    status: membershipStatus("status").notNull().default("pending"),
    createdAt: createdAt(),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => users.id),
  },
  (t) => [
    unique("memberships_org_user_uq").on(t.orgId, t.userId),
    unique("memberships_org_id_uq").on(t.orgId, t.id),
    index("memberships_user_idx").on(t.userId),
  ],
);

export const departments = pgTable(
  "departments",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("departments_org_id_uq").on(t.orgId, t.id)],
);

export const teams = pgTable(
  "teams",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    departmentId: uuid("department_id").notNull(),
    name: text("name").notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("teams_org_id_uq").on(t.orgId, t.id),
    foreignKey({
      name: "teams_department_fk",
      columns: [t.orgId, t.departmentId],
      foreignColumns: [departments.orgId, departments.id],
    }),
  ],
);

export const projects = pgTable(
  "projects",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [unique("projects_org_id_uq").on(t.orgId, t.id)],
);

export const projectTeams = pgTable(
  "project_teams",
  {
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    teamId: uuid("team_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.teamId] }),
    foreignKey({ name: "project_teams_project_fk", columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    foreignKey({ name: "project_teams_team_fk", columns: [t.orgId, t.teamId], foreignColumns: [teams.orgId, teams.id] }),
  ],
);

/** System roles have org_id NULL; custom roles belong to one organization. */
export const roles = pgTable(
  "roles",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id),
    key: text("key").notNull(),
    name: text("name").notNull(),
    isSystem: boolean("is_system").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    unique("roles_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("roles_system_key_uq").on(t.key).where(sql`${t.orgId} is null`),
    uniqueIndex("roles_org_key_uq").on(t.orgId, t.key).where(sql`${t.orgId} is not null`),
    check("roles_system_has_no_org", sql`(${t.isSystem} and ${t.orgId} is null) or (not ${t.isSystem} and ${t.orgId} is not null)`),
  ],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

/**
 * Role assignment (who has which role) is separate from scope (where it applies).
 * Exactly one scope column is set, matching scope_type; each has a composite FK so the
 * scoped entity must live in the same organization.
 */
export const roleAssignments = pgTable(
  "role_assignments",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    membershipId: uuid("membership_id").notNull(),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    scopeType: scopeType("scope_type").notNull(),
    departmentId: uuid("department_id"),
    teamId: uuid("team_id"),
    projectId: uuid("project_id"),
    createdAt: createdAt(),
    createdBy: uuid("created_by").references(() => users.id),
  },
  (t) => [
    foreignKey({ name: "role_assignments_membership_fk", columns: [t.orgId, t.membershipId], foreignColumns: [memberships.orgId, memberships.id] }),
    foreignKey({ name: "role_assignments_department_fk", columns: [t.orgId, t.departmentId], foreignColumns: [departments.orgId, departments.id] }),
    foreignKey({ name: "role_assignments_team_fk", columns: [t.orgId, t.teamId], foreignColumns: [teams.orgId, teams.id] }),
    foreignKey({ name: "role_assignments_project_fk", columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    check(
      "role_assignments_scope_matches",
      sql`(${t.scopeType} = 'organization' and ${t.departmentId} is null and ${t.teamId} is null and ${t.projectId} is null)
        or (${t.scopeType} = 'department' and ${t.departmentId} is not null and ${t.teamId} is null and ${t.projectId} is null)
        or (${t.scopeType} = 'team' and ${t.teamId} is not null and ${t.departmentId} is null and ${t.projectId} is null)
        or (${t.scopeType} = 'project' and ${t.projectId} is not null and ${t.departmentId} is null and ${t.teamId} is null)`,
    ),
    index("role_assignments_membership_idx").on(t.membershipId),
  ],
);

export const invitations = pgTable(
  "invitations",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    email: text("email").notNull(),
    roleId: uuid("role_id").notNull().references(() => roles.id),
    // Only a hash of the token is stored.
    tokenHash: text("token_hash").notNull().unique(),
    // NULL for the bootstrap invitation created by an operator (no inviting user exists yet).
    invitedBy: uuid("invited_by").references(() => users.id),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("invitations_org_idx").on(t.orgId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    orgId: uuid("org_id").references(() => organizations.id),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    // Redacted, minimal context only. Never secrets or record contents.
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.orgId, t.createdAt)],
);

// ---------------------------------------------------------------------------------------------
// Authentication tables (managed through Better Auth). JS property names must match Better Auth's
// field names. These tables are not tenant-scoped; access is always through the auth layer.
// ---------------------------------------------------------------------------------------------

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: id(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_sessions_user_idx").on(t.userId)],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: id(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_accounts_user_idx").on(t.userId), unique("auth_accounts_provider_uq").on(t.providerId, t.accountId)],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: id(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);

export const authTwoFactor = pgTable(
  "auth_two_factor",
  {
    id: id(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [index("auth_two_factor_user_idx").on(t.userId)],
);

export const authRateLimits = pgTable("auth_rate_limits", {
  id: id(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

/** Fixed-window limiter for application endpoints (Better Auth limits its own routes). */
export const appRateLimits = pgTable("app_rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

// ---------------------------------------------------------------------------------------------
// Work management (Phase 2)
// ---------------------------------------------------------------------------------------------

export const labels = pgTable(
  "labels",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    color: text("color").notNull().default("#64748b"),
    createdAt: createdAt(),
  },
  (t) => [
    unique("labels_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("labels_org_name_uq").on(t.orgId, sql`lower(${t.name})`),
    check("labels_color_hex", sql`${t.color} ~ '^#[0-9a-fA-F]{6}$'`),
  ],
);

/**
 * `start_date`/`due_date` are calendar dates (no time, no zone). `completed_at` is a UTC instant.
 * Workflow rules (status transitions, dependency gating) are enforced in the service layer; the
 * constraints below are the last line of defence for shape and integrity.
 */
export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    projectId: uuid("project_id").notNull(),
    parentId: uuid("parent_id"),
    // Set for occurrences generated from a recurring series (Phase 3).
    seriesId: uuid("series_id"),
    occurrenceDate: date("occurrence_date"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    status: taskStatus("status").notNull().default("todo"),
    priority: taskPriority("priority").notNull().default("medium"),
    startDate: date("start_date"),
    dueDate: date("due_date"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Remind N days before the due date (09:00 in the assignee's time zone). NULL = no reminder.
    reminderDaysBefore: integer("reminder_days_before"),
    primaryAssigneeId: uuid("primary_assignee_id"),
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    updatedBy: uuid("updated_by").references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: deletedAt(),
    deletedBy: uuid("deleted_by").references(() => users.id),
  },
  (t) => [
    unique("tasks_org_id_uq").on(t.orgId, t.id),
    foreignKey({ name: "tasks_project_fk", columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    foreignKey({ name: "tasks_parent_fk", columns: [t.orgId, t.parentId], foreignColumns: [t.orgId, t.id] }),
    foreignKey({ name: "tasks_assignee_fk", columns: [t.orgId, t.primaryAssigneeId], foreignColumns: [memberships.orgId, memberships.userId] }),
    check("tasks_title_len", sql`char_length(${t.title}) between 1 and 300`),
    check("tasks_description_len", sql`char_length(${t.description}) <= 20000`),
    check("tasks_date_range", sql`${t.startDate} is null or ${t.dueDate} is null or ${t.dueDate} >= ${t.startDate}`),
    check("tasks_not_own_parent", sql`${t.parentId} is null or ${t.parentId} <> ${t.id}`),
    check("tasks_completed_iff_done", sql`(${t.status} = 'done') = (${t.completedAt} is not null)`),
    check("tasks_reminder_range", sql`${t.reminderDaysBefore} is null or ${t.reminderDaysBefore} between 0 and 30`),
    // Soft-deleted occurrences release their slot so a paused/rescheduled series can regenerate that date.
    uniqueIndex("tasks_series_occurrence_uq").on(t.seriesId, t.occurrenceDate).where(sql`${t.seriesId} is not null and ${t.deletedAt} is null`),
    index("tasks_project_status_idx").on(t.orgId, t.projectId, t.status).where(sql`${t.deletedAt} is null`),
    index("tasks_assignee_idx").on(t.orgId, t.primaryAssigneeId, t.status).where(sql`${t.deletedAt} is null`),
    index("tasks_due_idx").on(t.orgId, t.dueDate).where(sql`${t.deletedAt} is null`),
    index("tasks_parent_idx").on(t.orgId, t.parentId),
  ],
);

export const taskAssignees = pgTable(
  "task_assignees",
  {
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    userId: uuid("user_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.userId] }),
    foreignKey({ name: "task_assignees_task_fk", columns: [t.orgId, t.taskId], foreignColumns: [tasks.orgId, tasks.id] }),
    foreignKey({ name: "task_assignees_member_fk", columns: [t.orgId, t.userId], foreignColumns: [memberships.orgId, memberships.userId] }),
    index("task_assignees_user_idx").on(t.orgId, t.userId),
  ],
);

/** `taskId` cannot start until `dependsOnId` is done (see docs/WORKFLOW.md). */
export const taskDependencies = pgTable(
  "task_dependencies",
  {
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    dependsOnId: uuid("depends_on_id").notNull(),
    createdBy: uuid("created_by").references(() => users.id),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.dependsOnId] }),
    foreignKey({ name: "task_dependencies_task_fk", columns: [t.orgId, t.taskId], foreignColumns: [tasks.orgId, tasks.id] }),
    foreignKey({ name: "task_dependencies_prereq_fk", columns: [t.orgId, t.dependsOnId], foreignColumns: [tasks.orgId, tasks.id] }),
    check("task_dependencies_not_self", sql`${t.taskId} <> ${t.dependsOnId}`),
    index("task_dependencies_prereq_idx").on(t.orgId, t.dependsOnId),
  ],
);

export const taskLabels = pgTable(
  "task_labels",
  {
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    labelId: uuid("label_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.labelId] }),
    foreignKey({ name: "task_labels_task_fk", columns: [t.orgId, t.taskId], foreignColumns: [tasks.orgId, tasks.id] }),
    foreignKey({ name: "task_labels_label_fk", columns: [t.orgId, t.labelId], foreignColumns: [labels.orgId, labels.id] }),
  ],
);

export const comments = pgTable(
  "comments",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    authorId: uuid("author_id").notNull().references(() => users.id),
    // Plain text. Never rendered as HTML.
    body: text("body").notNull(),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("comments_org_id_uq").on(t.orgId, t.id),
    foreignKey({ name: "comments_task_fk", columns: [t.orgId, t.taskId], foreignColumns: [tasks.orgId, tasks.id] }),
    check("comments_body_len", sql`char_length(${t.body}) between 1 and 10000`),
    index("comments_task_idx").on(t.orgId, t.taskId, t.createdAt),
  ],
);

export const commentMentions = pgTable(
  "comment_mentions",
  {
    orgId: uuid("org_id").notNull(),
    commentId: uuid("comment_id").notNull(),
    userId: uuid("user_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.commentId, t.userId] }),
    foreignKey({ name: "comment_mentions_comment_fk", columns: [t.orgId, t.commentId], foreignColumns: [comments.orgId, comments.id] }),
    foreignKey({ name: "comment_mentions_member_fk", columns: [t.orgId, t.userId], foreignColumns: [memberships.orgId, memberships.userId] }),
  ],
);

/** Append-only history of a task. Records which fields changed (and scalar values), never descriptions or comment text. */
export const taskActivity = pgTable(
  "task_activity",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    actorId: uuid("actor_id").references(() => users.id),
    type: text("type").notNull(),
    changes: jsonb("changes").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({ name: "task_activity_task_fk", columns: [t.orgId, t.taskId], foreignColumns: [tasks.orgId, tasks.id] }),
    index("task_activity_task_idx").on(t.orgId, t.taskId, t.createdAt),
  ],
);

export const attachments = pgTable(
  "attachments",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    uploadedBy: uuid("uploaded_by").notNull().references(() => users.id),
    // Opaque server-generated key; never derived from the user's file name.
    storageKey: text("storage_key").notNull().unique(),
    // Display-only, sanitized.
    filename: text("filename").notNull(),
    // Detected by the server from file contents, not taken from the client.
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("attachments_org_id_uq").on(t.orgId, t.id),
    foreignKey({ name: "attachments_task_fk", columns: [t.orgId, t.taskId], foreignColumns: [tasks.orgId, tasks.id] }),
    check("attachments_size", sql`${t.sizeBytes} > 0`),
    index("attachments_task_idx").on(t.orgId, t.taskId),
  ],
);

/**
 * Transactional outbox: services append an event in the same transaction as the change. A background
 * job later turns events into notifications, re-checking permissions at delivery time. Payloads hold
 * identifiers only, never titles or text.
 */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [index("outbox_events_pending_idx").on(t.createdAt).where(sql`${t.processedAt} is null`)],
);

// ---------------------------------------------------------------------------------------------
// Productivity and customization (Phase 3)
// ---------------------------------------------------------------------------------------------

export const customFieldType = pgEnum("custom_field_type", ["text", "number", "date", "dropdown", "checkbox"]);
export const viewScope = pgEnum("view_scope", ["personal", "team", "organization"]);
export const viewKind = pgEnum("view_kind", ["list", "board", "calendar", "timeline", "my_tasks"]);

/** A recurring task template. Occurrences are ordinary tasks linked by (series_id, occurrence_date). */
export const recurrenceSeries = pgTable(
  "recurrence_series",
  {
    id: id(),
    orgId: uuid("org_id").notNull(),
    projectId: uuid("project_id").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    priority: taskPriority("priority").notNull().default("medium"),
    primaryAssigneeId: uuid("primary_assignee_id"),
    reminderDaysBefore: integer("reminder_days_before"),
    // Days between an occurrence's date and its due date (0 = due on the occurrence date).
    dueOffsetDays: integer("due_offset_days").notNull().default(0),
    // Rule document validated by src/domain/recurrence.ts (frequency, interval, weekdays, ...).
    rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
    startDate: date("start_date").notNull(),
    endDate: date("end_date"),
    maxOccurrences: integer("max_occurrences"),
    // The time zone the series was created in; reminders are computed in the assignee's zone.
    timezone: text("timezone").notNull(),
    active: boolean("active").notNull().default(true),
    // Occurrences up to and including this date have been generated (idempotent high-water mark).
    generatedThrough: date("generated_through"),
    createdBy: uuid("created_by").notNull().references(() => users.id),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: deletedAt(),
  },
  (t) => [
    unique("recurrence_series_org_id_uq").on(t.orgId, t.id),
    foreignKey({ name: "recurrence_series_project_fk", columns: [t.orgId, t.projectId], foreignColumns: [projects.orgId, projects.id] }),
    foreignKey({ name: "recurrence_series_assignee_fk", columns: [t.orgId, t.primaryAssigneeId], foreignColumns: [memberships.orgId, memberships.userId] }),
    check("recurrence_series_title_len", sql`char_length(${t.title}) between 1 and 300`),
    check("recurrence_series_dates", sql`${t.endDate} is null or ${t.endDate} >= ${t.startDate}`),
    check("recurrence_series_offset", sql`${t.dueOffsetDays} between 0 and 365`),
    check("recurrence_series_max", sql`${t.maxOccurrences} is null or ${t.maxOccurrences} between 1 and 1000`),
  ],
);

export const customFieldDefs = pgTable(
  "custom_field_defs",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    name: text("name").notNull(),
    // The type cannot change after creation, so stored values always match their definition.
    type: customFieldType("type").notNull(),
    // Dropdown only: [{ id, label, archived? }]. Option ids are stable; labels may be renamed.
    options: jsonb("options").$type<{ id: string; label: string; archived?: boolean }[]>().notNull().default([]),
    // Number only.
    minValue: numeric("min_value"),
    maxValue: numeric("max_value"),
    // Typed default applied to new tasks (stored as text, parsed by type).
    defaultValue: text("default_value"),
    position: integer("position").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    unique("custom_field_defs_org_id_uq").on(t.orgId, t.id),
    uniqueIndex("custom_field_defs_name_uq").on(t.orgId, sql`lower(${t.name})`).where(sql`${t.archivedAt} is null`),
    check("custom_field_defs_name_len", sql`char_length(${t.name}) between 1 and 60`),
    check("custom_field_defs_range", sql`${t.minValue} is null or ${t.maxValue} is null or ${t.maxValue} >= ${t.minValue}`),
  ],
);

/** One typed column per kind (no catch-all JSON). At most one column may be set. */
export const customFieldValues = pgTable(
  "custom_field_values",
  {
    orgId: uuid("org_id").notNull(),
    taskId: uuid("task_id").notNull(),
    fieldId: uuid("field_id").notNull(),
    textValue: text("text_value"),
    numberValue: numeric("number_value"),
    dateValue: date("date_value"),
    optionValue: text("option_value"),
    boolValue: boolean("bool_value"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.fieldId] }),
    foreignKey({ name: "custom_field_values_task_fk", columns: [t.orgId, t.taskId], foreignColumns: [tasks.orgId, tasks.id] }),
    foreignKey({ name: "custom_field_values_field_fk", columns: [t.orgId, t.fieldId], foreignColumns: [customFieldDefs.orgId, customFieldDefs.id] }),
    check(
      "custom_field_values_single",
      sql`(case when ${t.textValue} is not null then 1 else 0 end + case when ${t.numberValue} is not null then 1 else 0 end + case when ${t.dateValue} is not null then 1 else 0 end + case when ${t.optionValue} is not null then 1 else 0 end + case when ${t.boolValue} is not null then 1 else 0 end) = 1`,
    ),
    index("custom_field_values_field_idx").on(t.orgId, t.fieldId),
  ],
);

export const savedViews = pgTable(
  "saved_views",
  {
    id: id(),
    orgId: uuid("org_id").notNull().references(() => organizations.id),
    ownerId: uuid("owner_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    scope: viewScope("scope").notNull().default("personal"),
    teamId: uuid("team_id"),
    kind: viewKind("kind").notNull().default("list"),
    // A filter *definition* (validated by zod on write and on read). Sharing a view never shares data.
    filter: jsonb("filter").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: deletedAt(),
  },
  (t) => [
    foreignKey({ name: "saved_views_team_fk", columns: [t.orgId, t.teamId], foreignColumns: [teams.orgId, teams.id] }),
    check("saved_views_team_scope", sql`(${t.scope} = 'team') = (${t.teamId} is not null)`),
    check("saved_views_name_len", sql`char_length(${t.name}) between 1 and 80`),
    index("saved_views_org_idx").on(t.orgId, t.scope),
  ],
);
