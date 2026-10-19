import { and, asc, eq, isNull, or } from "drizzle-orm";
import { can } from "@/authz/evaluate";
import { savedViews, teams, auditLogs } from "@/db/schema";
import { viewFilterSchema, type ViewFilter } from "@/domain/view-filter";
import { forbidden, notFound, validation } from "@/lib/errors";
import { listTasks } from "./tasks";
import type { TenantSession } from "./tenant";

type ViewRow = typeof savedViews.$inferSelect;
export type ViewScope = "personal" | "team" | "organization";
export type ViewKind = "list" | "board" | "calendar" | "timeline" | "my_tasks";

/**
 * Who may do what with a view:
 *  - personal:      its owner only (create, edit, delete, share).
 *  - team:          visible to anyone who can read that team's work. Created/edited/deleted by holders of
 *                   `view.share_team` for that team (the owner keeps edit/delete only while they still hold it).
 *  - organization:  visible to every approved member holding `org.read` somewhere. Created/edited/deleted
 *                   by holders of `view.share_org`.
 * Sharing a view shares only the *definition*. Each time it runs, results are computed for the person
 * opening it, under their own permissions.
 */
function canManage(s: TenantSession, v: Pick<ViewRow, "scope" | "teamId" | "ownerId">): boolean {
  if (v.scope === "personal") return v.ownerId === s.userId;
  if (v.scope === "team") return can(s.principal, "view.share_team", { orgId: s.orgId, teamId: v.teamId });
  return can(s.principal, "view.share_org", { orgId: s.orgId });
}

function canSee(s: TenantSession, v: Pick<ViewRow, "scope" | "teamId" | "ownerId">): boolean {
  if (v.scope === "personal") return v.ownerId === s.userId;
  if (v.scope === "team") return can(s.principal, "team.read", { orgId: s.orgId, teamId: v.teamId });
  return s.principal.assignments.some((a) => a.permissions.has("org.read"));
}

async function assertTeam(s: TenantSession, teamId: string) {
  const [t] = await s.tx.select({ id: teams.id }).from(teams).where(and(eq(teams.orgId, s.orgId), eq(teams.id, teamId), isNull(teams.deletedAt))).for("share");
  if (!t) throw notFound();
}

export interface ViewInput {
  name: string;
  kind: ViewKind;
  scope: ViewScope;
  teamId?: string | null;
  filter: unknown;
}

function parseInput(input: ViewInput) {
  const name = input.name.trim();
  if (!name || name.length > 80) throw validation("Name must be 1-80 characters");
  const filter = viewFilterSchema.safeParse(input.filter ?? {});
  if (!filter.success) throw validation("Invalid view filter");
  if (input.scope === "team" && !input.teamId) throw validation("A team view needs a team");
  if (input.scope !== "team" && input.teamId) throw validation("Only team views have a team");
  return { name, filter: filter.data };
}

export async function createView(s: TenantSession, input: ViewInput) {
  const { name, filter } = parseInput(input);
  s.requireAny("org.read");
  if (input.scope === "team") {
    await assertTeam(s, input.teamId!);
    if (!canManage(s, { scope: "team", teamId: input.teamId!, ownerId: s.userId })) throw forbidden({ permission: "view.share_team" });
  }
  if (input.scope === "organization" && !canManage(s, { scope: "organization", teamId: null, ownerId: s.userId })) throw forbidden({ permission: "view.share_org" });
  const [row] = await s.tx
    .insert(savedViews)
    .values({ orgId: s.orgId, ownerId: s.userId, name, kind: input.kind, scope: input.scope, teamId: input.teamId ?? null, filter })
    .returning();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "view.create", targetType: "view", targetId: row!.id, metadata: { scope: input.scope } });
  return row!;
}

export async function listViews(s: TenantSession) {
  const rows = await s.tx
    .select()
    .from(savedViews)
    .where(and(eq(savedViews.orgId, s.orgId), isNull(savedViews.deletedAt), or(eq(savedViews.scope, "organization"), eq(savedViews.scope, "team"), eq(savedViews.ownerId, s.userId))))
    .orderBy(asc(savedViews.name))
    .limit(300);
  return rows.filter((v) => canSee(s, v)).map((v) => ({ id: v.id, name: v.name, kind: v.kind, scope: v.scope, teamId: v.teamId, ownerId: v.ownerId, editable: canManage(s, v) }));
}

async function loadView(s: TenantSession, id: string): Promise<ViewRow> {
  const [v] = await s.tx.select().from(savedViews).where(and(eq(savedViews.orgId, s.orgId), eq(savedViews.id, id), isNull(savedViews.deletedAt)));
  if (!v || !canSee(s, v)) throw notFound(); // hidden views look nonexistent
  return v;
}

export async function updateView(s: TenantSession, id: string, patch: Partial<ViewInput>) {
  const v = await loadView(s, id);
  if (!canManage(s, v)) throw forbidden({ permission: "view.manage" });
  const target: ViewInput = {
    name: patch.name ?? v.name, kind: patch.kind ?? v.kind, scope: patch.scope ?? v.scope,
    teamId: patch.scope ? (patch.scope === "team" ? patch.teamId ?? null : null) : patch.teamId !== undefined ? patch.teamId : v.teamId,
    filter: patch.filter ?? v.filter,
  };
  const { name, filter } = parseInput(target);
  if (target.scope !== v.scope || target.teamId !== v.teamId) {
    // Changing who can see a view requires the right to share at the *new* level, too.
    if (target.scope === "team") await assertTeam(s, target.teamId!);
    if (!canManage(s, { scope: target.scope, teamId: target.teamId ?? null, ownerId: s.userId })) throw forbidden({ permission: "view.share" });
  }
  const [row] = await s.tx.update(savedViews).set({ name, kind: target.kind, scope: target.scope, teamId: target.teamId ?? null, filter, updatedAt: new Date() }).where(eq(savedViews.id, v.id)).returning();
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "view.update", targetType: "view", targetId: v.id, metadata: { scope: target.scope } });
  return row!;
}

export async function deleteView(s: TenantSession, id: string) {
  const v = await loadView(s, id);
  if (!canManage(s, v)) throw forbidden({ permission: "view.manage" });
  await s.tx.update(savedViews).set({ deletedAt: new Date() }).where(eq(savedViews.id, v.id));
  await s.tx.insert(auditLogs).values({ orgId: s.orgId, actorUserId: s.userId, action: "view.delete", targetType: "view", targetId: v.id });
}

/** Opens a view: permissions are evaluated *now*, for the opener, never for the view's author. */
export async function runView(s: TenantSession, id: string, opts: { today: string; limit?: number; offset?: number }) {
  const v = await loadView(s, id);
  const parsed = viewFilterSchema.safeParse(v.filter);
  if (!parsed.success) throw validation("This view is no longer valid");
  const f: ViewFilter = parsed.data;
  const { custom, ...rest } = f;
  const result = await listTasks(s, { ...rest, custom, today: opts.today, limit: opts.limit, offset: opts.offset });
  return { view: { id: v.id, name: v.name, kind: v.kind, scope: v.scope }, ...result };
}

/** The stored definition (filters) of a view the caller may see. Running it is a separate, permission-checked step. */
export async function getView(s: TenantSession, id: string) {
  const v = await loadView(s, id);
  return { id: v.id, name: v.name, kind: v.kind, scope: v.scope, teamId: v.teamId, filter: v.filter, editable: canManage(s, v) };
}
