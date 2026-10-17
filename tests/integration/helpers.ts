import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client";
import {
  departments, memberships, organizations, projects, roleAssignments, roles, teams, users,
} from "../../src/db/schema";
import { APP_ROLE } from "./global-setup";

const adminUrl = () => process.env.TEST_DATABASE_URL!;

function appUrl() {
  const u = new URL(adminUrl());
  u.username = APP_ROLE;
  u.password = "app";
  return u.toString();
}

/** `admin` bypasses RLS (fixtures only); `app` is the least-privilege runtime role under test. */
export function connect() {
  const admin = createDb(adminUrl());
  const app = createDb(appUrl());
  return { admin: admin.db, app: app.db, close: async () => { await admin.close(); await app.close(); } };
}

export async function makeOrg(admin: Db, name = "Org") {
  const [org] = await admin.insert(organizations).values({ name, slug: `${name.toLowerCase()}-${randomUUID()}` }).returning();
  const [dept] = await admin.insert(departments).values({ orgId: org!.id, name: `${name} Dept` }).returning();
  const [team] = await admin.insert(teams).values({ orgId: org!.id, departmentId: dept!.id, name: `${name} Team` }).returning();
  const [project] = await admin.insert(projects).values({ orgId: org!.id, name: `${name} Project` }).returning();
  return { org: org!, dept: dept!, team: team!, project: project! };
}

export async function makeUser(admin: Db, label = "u") {
  const [u] = await admin.insert(users).values({ email: `${label}-${randomUUID()}@example.test`, name: label }).returning();
  return u!;
}

export async function systemRoleId(admin: Db, key: string) {
  const [r] = await admin.select({ id: roles.id }).from(roles).where(and(isNull(roles.orgId), eq(roles.key, key)));
  return r!.id;
}

export async function addMember(
  admin: Db,
  orgId: string,
  userId: string,
  opts: { status?: "pending" | "approved" | "suspended" | "revoked"; role?: string; scope?: { type: "organization" } | { type: "department" | "team" | "project"; id: string } } = {},
) {
  const [m] = await admin.insert(memberships).values({ orgId, userId, status: opts.status ?? "approved" }).returning();
  if (opts.role) {
    const scope = opts.scope ?? { type: "organization" as const };
    await admin.insert(roleAssignments).values({
      orgId,
      membershipId: m!.id,
      roleId: await systemRoleId(admin, opts.role),
      scopeType: scope.type,
      departmentId: scope.type === "department" ? scope.id : null,
      teamId: scope.type === "team" ? scope.id : null,
      projectId: scope.type === "project" ? scope.id : null,
    });
  }
  return m!;
}
