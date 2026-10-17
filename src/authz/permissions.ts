/**
 * Permission catalog. Source of truth for what can be granted; system role bundles are
 * seeded into role_permissions from SYSTEM_ROLE_PERMISSIONS. See docs/RBAC.md.
 */
export const PERMISSIONS = [
  // Organization administration
  "org.read",
  "org.manage_settings",
  "org.manage_members",
  "org.approve_members",
  "org.manage_roles",
  "org.manage_integrations",
  "org.manage_custom_fields",
  "org.read_audit_log",
  // Structure
  "department.read",
  "department.manage",
  "team.read",
  "team.manage",
  "team.manage_members",
  // Projects
  "project.read",
  "project.create",
  "project.update",
  "project.delete",
  "project.manage_members",
  // Tasks (used from Phase 2)
  "task.create",
  "task.read",
  "task.update",
  "task.delete",
  "task.assign",
  "task.change_status",
  "task.manage_dependencies",
  "task.comment",
  "task.reopen",
  "task.attach",
  "label.manage",
  "view.share_team",
  "view.share_org",
  "series.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const SYSTEM_ROLE_KEYS = ["orgadmin", "manager", "member", "viewer"] as const;
export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

const READ: Permission[] = ["org.read", "department.read", "team.read", "project.read", "task.read"];

const MEMBER: Permission[] = [
  ...READ,
  "task.create",
  "task.update",
  "task.change_status",
  "task.comment",
  "task.attach",
];

const MANAGER: Permission[] = [
  ...MEMBER,
  "task.delete",
  "task.assign",
  "task.manage_dependencies",
  "project.create",
  "project.update",
  "project.manage_members",
  "team.manage_members",
  "task.reopen",
  "label.manage",
  "view.share_team",
  "series.manage",
];

/**
 * `superadmin` is intentionally absent: it is a platform-level flag on the user, not an
 * organization role. `custom` roles are created per organization with an explicit permission list.
 */
export const SYSTEM_ROLE_PERMISSIONS: Record<SystemRoleKey, readonly Permission[]> = {
  orgadmin: [...PERMISSIONS],
  manager: MANAGER,
  member: MEMBER,
  viewer: READ,
};

export const isPermission = (value: string): value is Permission =>
  (PERMISSIONS as readonly string[]).includes(value);
