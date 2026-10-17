"use client";
import { Suspense, useCallback, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { addDays } from "@/domain/time";
import { api } from "@/ui/api";
import { Empty, ErrorNote, Loading, PriorityBadge } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";
import type { TaskSummary } from "@/ui/tasks/model";
import { StatusSelect, useStatusChange, useToday } from "@/ui/tasks/shared";
import { TaskDrawer } from "@/ui/tasks/task-drawer";

function MyTasks() {
  const { orgId } = useOrg();
  const { t, date } = useI18n();
  const today = useToday();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const taskId = sp.get("task");
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const q = useQuery<{ items: TaskSummary[] }>(`mine:${orgId}:${version}`, () => api(`/api/orgs/${orgId}/tasks?assignee=me&status=todo,progress,review,blocked&sort=due&limit=100`), { refreshMs: 60_000 });
  const { change, busy } = useStatusChange(bump);
  const open = (id?: string) => router.replace(id ? `${pathname}?task=${id}` : pathname);

  if (q.loading && !q.data) return <Loading />;
  if (q.error && !q.data) return <ErrorNote error={q.error} onRetry={q.reload} />;
  const weekEnd = addDays(today, 7);
  const items = q.data?.items ?? [];
  const groups: { id: string; label: string; items: TaskSummary[] }[] = [
    { id: "overdue", label: t("ui.overdue"), items: items.filter((i) => i.dueDate && i.dueDate < today) },
    { id: "today", label: t("ui.today"), items: items.filter((i) => i.dueDate === today) },
    { id: "week", label: t("ui.this_week"), items: items.filter((i) => i.dueDate && i.dueDate > today && i.dueDate <= weekEnd) },
    { id: "later", label: t("ui.later"), items: items.filter((i) => i.dueDate && i.dueDate > weekEnd) },
    { id: "none", label: t("ui.no_date"), items: items.filter((i) => !i.dueDate) },
  ];
  return (
    <div className="stack">
      <h1>{t("ui.my_tasks")}</h1>
      {items.length === 0 && <Empty />}
      {groups.filter((g) => g.items.length).map((g) => (
        <section key={g.id} className="card" aria-labelledby={`g-${g.id}`}>
          <h2 id={`g-${g.id}`} className={g.id === "overdue" ? "overdue" : undefined}>{g.label} <span className="muted small">({g.items.length})</span></h2>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {g.items.map((i) => (
              <li key={i.id} className="row between" style={{ padding: "0.45rem 0", borderTop: "1px solid var(--border)" }}>
                <span style={{ minWidth: 0 }}><button className="task-title" onClick={() => open(i.id)}>{i.title}</button> <span className="muted small">{i.dueDate ? date(i.dueDate) : ""}</span></span>
                <span className="row"><PriorityBadge priority={i.priority} /><StatusSelect task={i} busy={busy === i.id} onChange={(to) => void change(i, to)} /></span>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <TaskDrawer taskId={taskId} onClose={() => open()} onChanged={bump} onOpen={open} />
    </div>
  );
}
export default function Page() { return <Suspense><MyTasks /></Suspense>; }
