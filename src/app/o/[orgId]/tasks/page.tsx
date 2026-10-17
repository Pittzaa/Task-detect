"use client";
import { Suspense, useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { api } from "@/ui/api";
import { Btn, Notice, Tabs, useToast } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";
import { BoardView } from "@/ui/tasks/board-view";
import { CalendarView } from "@/ui/tasks/calendar-view";
import { FilterBar } from "@/ui/tasks/filter-bar";
import { ListView } from "@/ui/tasks/list-view";
import { parseFilters, toApiQuery, toUrlParams, VIEWS, type Filters, type ViewName } from "@/ui/tasks/model";
import { NewTaskModal } from "@/ui/tasks/new-task";
import { SavedViews } from "@/ui/tasks/saved-views";
import type { Label, Project } from "@/ui/tasks/shared";
import { TaskDrawer } from "@/ui/tasks/task-drawer";
import { TimelineView } from "@/ui/tasks/timeline-view";

function TasksPage() {
  const { orgId, can } = useOrg();
  const { t, err } = useI18n();
  const toast = useToast();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const filters = parseFilters(new URLSearchParams(sp.toString()));
  const taskId = sp.get("task");
  const [version, setVersion] = useState(0);
  const [creating, setCreating] = useState(false);
  const [deleted, setDeleted] = useState<string>();
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const projects = useQuery<{ projects: Project[] }>(`projects:${orgId}`, () => api(`/api/orgs/${orgId}/projects`));
  const labels = useQuery<{ labels: Label[] }>(`labels:${orgId}`, () => api(`/api/orgs/${orgId}/labels`));

  const go = useCallback((f: Filters, task?: string | null) => router.replace(`${pathname}?${toUrlParams(f, { task: task ?? undefined }).toString()}`), [router, pathname]);
  const open = (id: string) => go(filters, id);

  useEffect(() => {
    const h = (e: Event) => setDeleted((e as CustomEvent<string>).detail);
    window.addEventListener("task-deleted", h);
    return () => window.removeEventListener("task-deleted", h);
  }, []);

  async function undo() {
    if (!deleted) return;
    try { await api(`/api/orgs/${orgId}/tasks/${deleted}/restore`, { method: "POST" }); setDeleted(undefined); bump(); } catch (e) { toast(err(e), "error"); }
  }

  const projectList = projects.data?.projects ?? [];
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>{t("ui.tasks")}</h1>
        <div className="row">
          <SavedViews filters={filters} onApply={(f) => go(f)} />
          <Btn kind="primary" onClick={() => setCreating(true)} disabled={projectList.length === 0 || !can.createTask}>+ {t("ui.new_task")}</Btn>
        </div>
      </div>
      {deleted && <Notice kind="warn">{t("ui.delete_task")} <Btn small onClick={() => void undo()}>{t("ui.restore")}</Btn></Notice>}
      <Tabs<ViewName> label={t("ui.tasks")} value={filters.view} onChange={(view) => go({ ...filters, view }, taskId)} tabs={VIEWS.map((v) => ({ id: v, label: t(v === "list" ? "ui.list" : v === "board" ? "ui.board" : v === "calendar" ? "ui.calendar" : "ui.timeline") }))} />
      <FilterBar filters={filters} onChange={(f) => go(f, taskId)} projects={projectList} labels={labels.data?.labels ?? []} />
      {filters.view === "list" && <ListView key={toApiQuery(filters)} filters={filters} projects={projectList} onOpen={open} version={version} onChanged={bump} />}
      {filters.view === "board" && <BoardView filters={filters} onOpen={open} version={version} onChanged={bump} />}
      {filters.view === "calendar" && <CalendarView filters={filters} onOpen={open} version={version} />}
      {filters.view === "timeline" && <TimelineView filters={filters} onOpen={open} version={version} />}
      <TaskDrawer taskId={taskId} onClose={() => go(filters, null)} onChanged={bump} onOpen={open} />
      <NewTaskModal open={creating} onClose={() => setCreating(false)} projects={projectList} defaultProject={filters.project} onCreated={(id) => { setCreating(false); bump(); go(filters, id); }} />
    </div>
  );
}

export default function Page() {
  return <Suspense><TasksPage /></Suspense>;
}
