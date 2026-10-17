"use client";
import { useState } from "react";
import { TASK_PRIORITIES, TASK_STATUSES } from "@/domain/workflow";
import { api } from "@/ui/api";
import { ErrorNote, Loading } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";
import type { Project } from "@/ui/tasks/shared";

interface Dash {
  totals: { open: number; overdue: number; dueThisWeek: number; doneLast7Days: number; mineOpen: number; mineOverdue: number };
  byStatus: Record<string, number>; byPriority: Record<string, number>;
  completionTrend: { date: string; count: number }[]; projects: { id: string; name: string; total: number; done: number }[];
}

function Kpi({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return <div className="card"><div className={`kpi ${warn && value > 0 ? "overdue" : ""}`}>{value}</div><div className="muted">{label}</div></div>;
}

function Bars({ title, data, order, label }: { title: string; data: Record<string, number>; order: readonly string[]; label: (k: string) => string }) {
  const max = Math.max(1, ...order.map((k) => data[k] ?? 0));
  return (
    <section className="card" aria-label={title}>
      <h2>{title}</h2>
      {order.map((k) => (
        <div key={k} style={{ margin: "0.4rem 0" }}>
          <div className="row between small"><span>{label(k)}</span><span>{data[k] ?? 0}</span></div>
          <div className="bar" role="img" aria-label={`${label(k)}: ${data[k] ?? 0}`}><span style={{ width: `${((data[k] ?? 0) / max) * 100}%` }} /></div>
        </div>
      ))}
    </section>
  );
}

export default function DashboardPage() {
  const { orgId } = useOrg();
  const { t, date } = useI18n();
  const [project, setProject] = useState("");
  const projects = useQuery<{ projects: Project[] }>(`projects:${orgId}`, () => api(`/api/orgs/${orgId}/projects`));
  const q = useQuery<Dash>(`dash:${orgId}:${project}`, () => api<Dash>(`/api/orgs/${orgId}/dashboard${project ? `?projectId=${project}` : ""}`), { refreshMs: 60_000 });
  if (q.loading && !q.data) return <Loading />;
  if (q.error && !q.data) return <ErrorNote error={q.error} onRetry={q.reload} />;
  const d = q.data!;
  const maxTrend = Math.max(1, ...d.completionTrend.map((x) => x.count));
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>{t("ui.dashboard")}</h1>
        <label className="row"><span className="label">{t("ui.project")}</span>
          <select value={project} onChange={(e) => setProject(e.target.value)}><option value="">{t("ui.all_projects")}</option>{projects.data?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
        </label>
      </div>
      <div className="grid cols-4">
        <Kpi label={t("ui.open")} value={d.totals.open} /><Kpi label={t("ui.overdue")} value={d.totals.overdue} warn /><Kpi label={t("ui.due_this_week")} value={d.totals.dueThisWeek} /><Kpi label={t("ui.done_7d")} value={d.totals.doneLast7Days} />
        <Kpi label={t("ui.my_open")} value={d.totals.mineOpen} /><Kpi label={t("ui.my_overdue")} value={d.totals.mineOverdue} warn />
      </div>
      <div className="grid cols-2">
        <Bars title={t("ui.by_status")} data={d.byStatus} order={TASK_STATUSES} label={(k) => t(`status.${k}` as never)} />
        <Bars title={t("ui.by_priority")} data={d.byPriority} order={[...TASK_PRIORITIES].reverse()} label={(k) => t(`priority.${k}` as never)} />
      </div>
      <section className="card" aria-labelledby="h-trend">
        <h2 id="h-trend">{t("ui.trend")}</h2>
        <svg viewBox="0 0 280 80" width="100%" height="90" role="img" aria-label={t("ui.trend")}>
          {d.completionTrend.map((x, i) => {
            const h = (x.count / maxTrend) * 60;
            return <g key={x.date}><rect x={i * 20 + 3} y={70 - h} width="14" height={Math.max(h, 1)} rx="2" fill="var(--primary)"><title>{`${date(x.date)}: ${x.count}`}</title></rect></g>;
          })}
        </svg>
      </section>
      <section className="card" aria-labelledby="h-proj">
        <h2 id="h-proj">{t("ui.projects")}</h2>
        {d.projects.map((p) => (
          <div key={p.id} style={{ margin: "0.5rem 0" }}>
            <div className="row between"><strong>{p.name}</strong><span className="muted small">{p.done}/{p.total}</span></div>
            <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={p.total} aria-valuenow={p.done} aria-label={p.name}><span style={{ width: p.total ? `${(p.done / p.total) * 100}%` : "0%" }} /></div>
          </div>
        ))}
      </section>
    </div>
  );
}
