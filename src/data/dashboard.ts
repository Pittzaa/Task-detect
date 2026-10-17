import { sql } from "drizzle-orm";
import { addDays } from "@/domain/time";
import { accessibleProjectIds } from "./scope";
import type { TenantSession } from "./tenant";

const STATUSES = ["todo", "progress", "review", "done", "cancelled", "blocked"] as const;
const PRIORITIES = ["low", "medium", "high", "urgent"] as const;

type Rows<T> = { rows: T[] };

/**
 * Aggregates over the projects the caller can read (and only those). `today` is the caller's local
 * calendar date and `timezone` decides which day a completion belongs to.
 */
export async function getDashboard(s: TenantSession, opts: { today: string; timezone: string; projectId?: string }) {
  const accessible = await accessibleProjectIds(s, "task.read");
  const empty = { totals: { open: 0, overdue: 0, dueThisWeek: 0, doneLast7Days: 0, mineOpen: 0, mineOverdue: 0 }, byStatus: Object.fromEntries(STATUSES.map((x) => [x, 0])), byPriority: Object.fromEntries(PRIORITIES.map((x) => [x, 0])), completionTrend: [] as { date: string; count: number }[], projects: [] as { id: string; name: string; total: number; done: number }[] };
  if (Array.isArray(accessible) && accessible.length === 0) return empty;

  const scopeCond = accessible === "all" ? sql`true` : sql`t.project_id in (${sql.join(accessible.map((id) => sql`${id}`), sql`, `)})`;
  const projCond = opts.projectId ? sql`t.project_id = ${opts.projectId}` : sql`true`;
  const base = sql`t.org_id = ${s.orgId} and t.deleted_at is null and ${scopeCond} and ${projCond}`;
  const weekEnd = addDays(opts.today, 6);
  const trendFrom = addDays(opts.today, -13);

  const totals = (await s.tx.execute(sql`
    select
      count(*) filter (where t.status not in ('done','cancelled'))::int as open,
      count(*) filter (where t.status not in ('done','cancelled') and t.due_date < ${opts.today})::int as overdue,
      count(*) filter (where t.status not in ('done','cancelled') and t.due_date between ${opts.today} and ${weekEnd})::int as due_this_week,
      count(*) filter (where t.status = 'done' and (t.completed_at at time zone ${opts.timezone})::date >= ${addDays(opts.today, -6)})::int as done_last_7,
      count(*) filter (where t.status not in ('done','cancelled') and (t.primary_assignee_id = ${s.userId} or exists (select 1 from task_assignees a where a.task_id = t.id and a.org_id = t.org_id and a.user_id = ${s.userId})))::int as mine_open,
      count(*) filter (where t.status not in ('done','cancelled') and t.due_date < ${opts.today} and (t.primary_assignee_id = ${s.userId} or exists (select 1 from task_assignees a where a.task_id = t.id and a.org_id = t.org_id and a.user_id = ${s.userId})))::int as mine_overdue
    from tasks t where ${base}`)) as unknown as Rows<Record<string, number>>;
  const byStatus = (await s.tx.execute(sql`select t.status::text as k, count(*)::int as n from tasks t where ${base} group by t.status`)) as unknown as Rows<{ k: string; n: number }>;
  const byPriority = (await s.tx.execute(sql`select t.priority::text as k, count(*)::int as n from tasks t where ${base} and t.status not in ('done','cancelled') group by t.priority`)) as unknown as Rows<{ k: string; n: number }>;
  const trend = (await s.tx.execute(sql`
    select (t.completed_at at time zone ${opts.timezone})::date::text as d, count(*)::int as n
    from tasks t where ${base} and t.status = 'done' and (t.completed_at at time zone ${opts.timezone})::date >= ${trendFrom}
    group by 1 order by 1`)) as unknown as Rows<{ d: string; n: number }>;
  const perProject = (await s.tx.execute(sql`
    select p.id::text as id, p.name, count(t.id)::int as total, count(t.id) filter (where t.status = 'done')::int as done
    from projects p left join tasks t on t.project_id = p.id and t.org_id = p.org_id and t.deleted_at is null
    where p.org_id = ${s.orgId} and p.deleted_at is null and ${accessible === "all" ? sql`true` : sql`p.id in (${sql.join(accessible.map((id) => sql`${id}`), sql`, `)})`} and ${opts.projectId ? sql`p.id = ${opts.projectId}` : sql`true`}
    group by p.id, p.name order by p.name limit 100`)) as unknown as Rows<{ id: string; name: string; total: number; done: number }>;

  const t = totals.rows[0]!;
  const days: { date: string; count: number }[] = [];
  for (let i = 0; i < 14; i++) {
    const date = addDays(trendFrom, i);
    days.push({ date, count: trend.rows.find((r) => r.d === date)?.n ?? 0 });
  }
  return {
    totals: { open: t.open!, overdue: t.overdue!, dueThisWeek: t.due_this_week!, doneLast7Days: t.done_last_7!, mineOpen: t.mine_open!, mineOverdue: t.mine_overdue! },
    byStatus: { ...empty.byStatus, ...Object.fromEntries(byStatus.rows.map((r) => [r.k, r.n])) },
    byPriority: { ...empty.byPriority, ...Object.fromEntries(byPriority.rows.map((r) => [r.k, r.n])) },
    completionTrend: days,
    projects: perProject.rows,
  };
}
