"use client";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "@/domain/workflow";
import { Btn } from "../components";
import { useI18n } from "../i18n";
import type { Filters } from "./model";
import type { Label, Project } from "./shared";

function MultiToggle<T extends string>({ legend, options, value, onChange, label }: { legend: string; options: readonly T[]; value: T[]; onChange: (v: T[]) => void; label: (v: T) => string }) {
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="sr-only">{legend}</legend>
      <div className="row" style={{ gap: "0.35rem" }} role="group" aria-label={legend}>
        {options.map((o) => {
          const on = value.includes(o);
          return <button key={o} type="button" className="btn small" aria-pressed={on} style={on ? { background: "var(--primary-soft)", borderColor: "var(--primary)", color: "var(--primary)" } : undefined} onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}>{label(o)}</button>;
        })}
      </div>
    </fieldset>
  );
}

export function FilterBar({ filters, onChange, projects, labels, showView }: { filters: Filters; onChange: (f: Filters) => void; projects: Project[]; labels: Label[]; showView?: boolean }) {
  const { t } = useI18n();
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  void showView;
  return (
    <div className="card" role="search" aria-label={t("ui.filters")} style={{ padding: "0.75rem" }}>
      <div className="row" style={{ alignItems: "flex-end" }}>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-q">{t("ui.search")}</label>
          <input id="f-q" type="search" value={filters.q ?? ""} onChange={(e) => set({ q: e.target.value || undefined })} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-project">{t("ui.project")}</label>
          <select id="f-project" value={filters.project ?? ""} onChange={(e) => set({ project: e.target.value || undefined })}>
            <option value="">{t("ui.all_projects")}</option>
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-assignee">{t("ui.assignee")}</label>
          <select id="f-assignee" value={filters.assignee ?? ""} onChange={(e) => set({ assignee: e.target.value || undefined })}>
            <option value="">{t("ui.assignee_any")}</option>
            <option value="me">{t("ui.me")}</option>
          </select>
        </div>
        {labels.length > 0 && (
          <div className="field" style={{ margin: 0 }}>
            <label htmlFor="f-label">{t("ui.labels")}</label>
            <select id="f-label" value={filters.label ?? ""} onChange={(e) => set({ label: e.target.value || undefined })}>
              <option value="">{t("ui.all")}</option>
              {labels.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </div>
        )}
        <div className="field" style={{ margin: 0 }}>
          <label htmlFor="f-sort">{t("ui.sort")}</label>
          <select id="f-sort" value={filters.sort ?? "due"} onChange={(e) => set({ sort: e.target.value as Filters["sort"] })}>
            <option value="due">{t("ui.sort_due")}</option><option value="priority">{t("ui.sort_priority")}</option><option value="created">{t("ui.sort_created")}</option><option value="updated">{t("ui.sort_updated")}</option><option value="title">{t("ui.sort_title")}</option>
          </select>
        </div>
      </div>
      <div className="row" style={{ marginTop: "0.6rem" }}>
        <MultiToggle<TaskStatus> legend={t("ui.status")} options={TASK_STATUSES} value={filters.status} onChange={(status) => set({ status })} label={(s) => t(`status.${s}` as never)} />
        <MultiToggle<TaskPriority> legend={t("ui.priority")} options={TASK_PRIORITIES} value={filters.priority} onChange={(priority) => set({ priority })} label={(p) => t(`priority.${p}` as never)} />
        <label className="row" style={{ gap: "0.3rem" }}><input type="checkbox" checked={!!filters.overdue} onChange={(e) => set({ overdue: e.target.checked || undefined })} /> {t("ui.only_overdue")}</label>
        <label className="row" style={{ gap: "0.3rem" }}><input type="checkbox" checked={!!filters.topLevel} onChange={(e) => set({ topLevel: e.target.checked || undefined })} /> {t("ui.top_level")}</label>
        <Btn small onClick={() => onChange({ view: filters.view, status: [], priority: [] })}>{t("ui.cancel")}</Btn>
      </div>
    </div>
  );
}
