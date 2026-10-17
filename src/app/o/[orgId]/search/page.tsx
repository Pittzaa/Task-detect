"use client";
import Link from "next/link";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { api } from "@/ui/api";
import { ErrorNote, Loading, StatusBadge } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";
import type { TaskStatus } from "@/domain/workflow";

interface Res { tasks: { id: string; title: string; status: TaskStatus; snippet: string | null }[]; projects: { id: string; name: string }[]; teams: { id: string; name: string }[]; departments: { id: string; name: string }[] }

function Results() {
  const { orgId } = useOrg();
  const { t } = useI18n();
  const q = useSearchParams().get("q") ?? "";
  const r = useQuery<Res>(q.length >= 2 ? `search:${orgId}:${q}` : null, () => api<Res>(`/api/orgs/${orgId}/search?q=${encodeURIComponent(q)}`));
  const none = r.data && !r.data.tasks.length && !r.data.projects.length && !r.data.teams.length && !r.data.departments.length;
  return (
    <div className="stack">
      <h1>{t("ui.search")}: “{q}”</h1>
      {r.loading && !r.data && <Loading />}
      {r.error && <ErrorNote error={r.error} onRetry={r.reload} />}
      {none && <p className="muted">{t("ui.no_results")}</p>}
      {!!r.data?.tasks.length && <section className="card"><h2>{t("ui.tasks")}</h2><ul style={{ paddingLeft: "1.1rem" }}>{r.data.tasks.map((x) => <li key={x.id}><Link href={`/o/${orgId}/tasks?task=${x.id}`}>{x.title}</Link> <StatusBadge status={x.status} />{x.snippet && <div className="muted small pre-wrap">{x.snippet}</div>}</li>)}</ul></section>}
      {!!r.data?.projects.length && <section className="card"><h2>{t("ui.projects")}</h2><ul style={{ paddingLeft: "1.1rem" }}>{r.data.projects.map((x) => <li key={x.id}><Link href={`/o/${orgId}/tasks?project=${x.id}`}>{x.name}</Link></li>)}</ul></section>}
      {!!r.data?.teams.length && <section className="card"><h2>{t("ui.teams")}</h2><ul style={{ paddingLeft: "1.1rem" }}>{r.data.teams.map((x) => <li key={x.id}>{x.name}</li>)}</ul></section>}
      {!!r.data?.departments.length && <section className="card"><h2>{t("ui.departments")}</h2><ul style={{ paddingLeft: "1.1rem" }}>{r.data.departments.map((x) => <li key={x.id}>{x.name}</li>)}</ul></section>}
    </div>
  );
}
export default function Page() { return <Suspense><Results /></Suspense>; }
