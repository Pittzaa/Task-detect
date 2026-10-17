import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  integer,
  check,
  foreignKey,
  index,
  jsonb,
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
