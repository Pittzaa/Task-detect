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

  // One pass over the caller's tasks computes every counter (it used to be four separate scans of the same rows). The expensive per-row
  // expressions are evaluated once in the inner query; "mine" uses an IN-subquery, which PostgreSQL runs once as a hashed set, instead of
  // a correlated EXISTS per row (about five times faster on 20 000 tasks: tests/load notes in docs/TESTING.md).
  const mine = sql`(t.primary_assignee_id = ${s.userId} or t.id in (select a.task_id from task_assignees a where a.org_id = ${s.orgId} and a.user_id = ${s.userId}))`;
  const days: { date: string; count: number }[] = Array.from({ length: 14 }, (_, i) => ({ date: addDays(trendFrom, i), count: 0 }));
  const columns = [
    sql`count(*) filter (where open)::int as open`,
    sql`count(*) filter (where open and due_date < ${opts.today})::int as overdue`,
    sql`count(*) filter (where open and due_date between ${opts.today} and ${weekEnd})::int as due_this_week`,
    sql`count(*) filter (where status = 'done' and done_day >= ${addDays(opts.today, -6)}::date)::int as done_last_7`,
    sql`count(*) filter (where open and mine)::int as mine_open`,
    sql`count(*) filter (where open and due_date < ${opts.today} and mine)::int as mine_overdue`,
    ...STATUSES.map((x) => sql.raw(`count(*) filter (where status = '${x}')::int as s_${x}`)),
    ...PRIORITIES.map((x) => sql.raw(`count(*) filter (where open and priority = '${x}')::int as p_${x}`)),
    ...days.map((d, i) => sql`count(*) filter (where status = 'done' and done_day = ${d.date}::date)::int as d_${sql.raw(String(i))}`),
  ];
  const inner = sql`select t.status, t.priority, t.due_date, t.status not in ('done','cancelled') as open,
      case when t.status = 'done' then (t.completed_at at time zone ${opts.timezone})::date end as done_day, ${mine} as mine
    from tasks t where ${base}`;
  const totals = (await s.tx.execute(sql`select ${sql.join(columns, sql`, `)} from (${inner}) x`)) as unknown as Rows<Record<string, number>>;
  const perProject = (await s.tx.execute(sql`
    select p.id::text as id, p.name, count(t.id)::int as total, count(t.id) filter (where t.status = 'done')::int as done
    from projects p left join tasks t on t.project_id = p.id and t.org_id = p.org_id and t.deleted_at is null
    where p.org_id = ${s.orgId} and p.deleted_at is null and ${accessible === "all" ? sql`true` : sql`p.id in (${sql.join(accessible.map((id) => sql`${id}`), sql`, `)})`} and ${opts.projectId ? sql`p.id = ${opts.projectId}` : sql`true`}
    group by p.id, p.name order by p.name limit 100`)) as unknown as Rows<{ id: string; name: string; total: number; done: number }>;

  const t = totals.rows[0]!;
  days.forEach((d, i) => { d.count = t[`d_${i}`] ?? 0; });
  return {
    totals: { open: t.open!, overdue: t.overdue!, dueThisWeek: t.due_this_week!, doneLast7Days: t.done_last_7!, mineOpen: t.mine_open!, mineOverdue: t.mine_overdue! },
    byStatus: Object.fromEntries(STATUSES.map((x) => [x, t[`s_${x}`] ?? 0])),
    byPriority: Object.fromEntries(PRIORITIES.map((x) => [x, t[`p_${x}`] ?? 0])),
    completionTrend: days,
    projects: perProject.rows,
  };
}
