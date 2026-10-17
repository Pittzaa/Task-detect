"use client";
import { useState } from "react";
import { TASK_PRIORITIES, type TaskPriority } from "@/domain/workflow";
import { addDays } from "@/domain/time";
import { api } from "@/ui/api";
import { Btn, Empty, ErrorNote, Field, Loading, Modal, Notice, TableWrap, useToast } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";
import { useToday, type Person, type Project } from "@/ui/tasks/shared";

type Rule = { freq: "daily"; interval: number } | { freq: "weekly"; interval: number; weekdays: number[] } | { freq: "monthly"; interval: number; dayOfMonth: number };
interface Series {
  id: string; title: string; description: string; priority: TaskPriority; primaryAssigneeId: string | null; reminderDaysBefore: number | null; dueOffsetDays: number;
  rule: Rule; startDate: string; endDate: string | null; maxOccurrences: number | null; active: boolean;
}

const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday first; 0 = Sunday

function useWeekdayNames() {
  const { locale } = useI18n();
  const f = new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { weekday: "short", timeZone: "UTC" });
  // 2026-03-01 is a Sunday
  return (wd: number) => f.format(new Date(`${addDays("2026-03-01", wd)}T00:00:00Z`));
}

export default function RecurringPage() {
  const { orgId } = useOrg();
  const { t, date } = useI18n();
  const toast = useToast();
  const weekday = useWeekdayNames();
  const [chosen, setChosen] = useState("");
  const [editing, setEditing] = useState<Series | "new">();
  const projects = useQuery<{ projects: Project[] }>(`projects:${orgId}`, () => api(`/api/orgs/${orgId}/projects`));
  const projectId = chosen || projects.data?.projects[0]?.id || "";
  const list = useQuery<{ series: Series[] }>(projectId ? `series:${orgId}:${projectId}` : null, () => api(`/api/orgs/${orgId}/series?projectId=${projectId}`));

  const summary = (r: Rule) => {
    const unit = r.freq === "daily" ? t("ui.unit_days") : r.freq === "weekly" ? t("ui.unit_weeks") : t("ui.unit_months");
    const extra = r.freq === "weekly" ? ` · ${WEEK_ORDER.filter((d) => r.weekdays.includes(d)).map(weekday).join(", ")}` : r.freq === "monthly" ? ` · ${t("ui.day_of_month")} ${r.dayOfMonth}` : "";
    return `${t("ui.every_n")} ${r.interval} ${unit}${extra}`;
  };
  async function patch(s: Series, body: object) {
    try { await api(`/api/orgs/${orgId}/series/${s.id}`, { method: "PATCH", body }); list.reload(); } catch (e) { toast(e instanceof Error ? e.message : t("error.generic"), "error"); }
  }
  async function remove(s: Series) {
    if (!window.confirm(t("ui.confirm_delete_series"))) return;
    try { await api(`/api/orgs/${orgId}/series/${s.id}`, { method: "DELETE" }); list.reload(); } catch (e) { toast(e instanceof Error ? e.message : t("error.generic"), "error"); }
  }

  if (projects.loading && !projects.data) return <Loading />;
  if (projects.error) return <ErrorNote error={projects.error} onRetry={projects.reload} />;
  return (
    <div className="stack">
      <div className="row between">
        <h1 style={{ margin: 0 }}>{t("ui.recurring_tasks")}</h1>
        <Btn kind="primary" onClick={() => setEditing("new")} disabled={!projectId}>+ {t("ui.new_series")}</Btn>
      </div>
      <p className="muted">{t("ui.recurring_hint")}</p>
      <div className="field" style={{ maxWidth: 360 }}>
        <label htmlFor="series-project">{t("ui.project")}</label>
        <select id="series-project" value={projectId} onChange={(e) => setChosen(e.target.value)}>{projects.data?.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </div>
      {list.loading && !list.data && <Loading />}
      {list.error && <ErrorNote error={list.error} onRetry={list.reload} />}
      {list.data && list.data.series.length === 0 && <Empty />}
      {!!list.data?.series.length && (
        <TableWrap label={t("ui.recurring_tasks")}>
          <table>
            <thead><tr><th>{t("ui.title")}</th><th>{t("ui.schedule")}</th><th>{t("ui.starts")}</th><th>{t("ui.status")}</th><th><span className="sr-only">{t("ui.edit")}</span></th></tr></thead>
            <tbody>
              {list.data.series.map((s) => (
                <tr key={s.id}>
                  <td>{s.title}</td>
                  <td>{summary(s.rule)}</td>
                  <td>{date(s.startDate)}{s.endDate ? ` → ${date(s.endDate)}` : ""}</td>
                  <td><span className="badge" data-s={s.active ? "done" : "blocked"}>{s.active ? t("ui.series_active") : t("ui.series_paused")}</span></td>
                  <td>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      <Btn small onClick={() => void patch(s, { active: !s.active })}>{s.active ? t("ui.pause") : t("ui.resume")}</Btn>
                      <Btn small onClick={() => setEditing(s)} aria-label={`${t("ui.edit")}: ${s.title}`}>{t("ui.edit")}</Btn>
                      <Btn small kind="danger" onClick={() => void remove(s)} aria-label={`${t("ui.delete")}: ${s.title}`}>{t("ui.delete")}</Btn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {editing && <SeriesForm key={editing === "new" ? "new" : editing.id} series={editing === "new" ? undefined : editing} projectId={projectId} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); list.reload(); }} />}
    </div>
  );
}

function SeriesForm({ series, projectId, onClose, onSaved }: { series?: Series; projectId: string; onClose: () => void; onSaved: () => void }) {
  const { orgId } = useOrg();
  const { t, err } = useI18n();
  const toast = useToast();
  const today = useToday();
  const weekday = useWeekdayNames();
  const [title, setTitle] = useState(series?.title ?? "");
  const [description, setDescription] = useState(series?.description ?? "");
  const [priority, setPriority] = useState<TaskPriority>(series?.priority ?? "medium");
  const [assignee, setAssignee] = useState(series?.primaryAssigneeId ?? "");
  const [freq, setFreq] = useState<Rule["freq"]>(series?.rule.freq ?? "weekly");
  const [interval, setIntervalN] = useState(series?.rule.interval ?? 1);
  const [weekdays, setWeekdays] = useState<number[]>(series?.rule.freq === "weekly" ? series.rule.weekdays : [1]);
  const [dayOfMonth, setDayOfMonth] = useState(series?.rule.freq === "monthly" ? series.rule.dayOfMonth : 1);
  const [startDate, setStartDate] = useState(series?.startDate ?? today);
  const [endDate, setEndDate] = useState(series?.endDate ?? "");
  const [max, setMax] = useState(series?.maxOccurrences ? String(series.maxOccurrences) : "");
  const [reminder, setReminder] = useState(series?.reminderDaysBefore == null ? "" : String(series.reminderDaysBefore));
  const [dueOffset, setDueOffset] = useState(String(series?.dueOffsetDays ?? 0));
  const [applyFuture, setApplyFuture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const people = useQuery<{ people: Person[] }>(`people:${orgId}:${projectId}`, () => api(`/api/orgs/${orgId}/projects/${projectId}/people`));

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined);
    const rule: Rule = freq === "daily" ? { freq, interval } : freq === "weekly" ? { freq, interval, weekdays } : { freq, interval, dayOfMonth };
    const body = {
      title, description, priority, primaryAssigneeId: assignee || null, rule, startDate, endDate: endDate || null, maxOccurrences: max ? Number(max) : null,
      reminderDaysBefore: reminder === "" ? null : Number(reminder), dueOffsetDays: Number(dueOffset) || 0,
    };
    try {
      if (series) await api(`/api/orgs/${orgId}/series/${series.id}`, { method: "PATCH", body: { ...body, applyToExisting: applyFuture ? "open_future" : "none" } });
      else {
        const r = await api<{ generated: number }>(`/api/orgs/${orgId}/series`, { method: "POST", body: { ...body, projectId } });
        toast(t("ui.series_created", { n: r.generated }));
      }
      onSaved();
    } catch (e2) { setError(err(e2)); } finally { setBusy(false); }
  }

  return (
    <Modal open onClose={onClose} title={series ? `${t("ui.edit")}: ${series.title}` : t("ui.new_series")}>
      <form onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <Field label={t("ui.title")}>{(id) => <input id={id} required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} />}</Field>
        <Field label={t("ui.description")}>{(id) => <textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="grid cols-2">
          <Field label={t("ui.priority")}>{(id) => <select id={id} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{t(`priority.${p}` as never)}</option>)}</select>}</Field>
          <Field label={t("ui.assignee")}>{(id) => <select id={id} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">{t("ui.unassigned")}</option>{people.data?.people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
          <Field label={t("ui.repeat")}>{(id) => <select id={id} value={freq} onChange={(e) => setFreq(e.target.value as Rule["freq"])}><option value="daily">{t("ui.freq_daily")}</option><option value="weekly">{t("ui.freq_weekly")}</option><option value="monthly">{t("ui.freq_monthly")}</option></select>}</Field>
          <Field label={`${t("ui.every_n")} (${freq === "daily" ? t("ui.unit_days") : freq === "weekly" ? t("ui.unit_weeks") : t("ui.unit_months")})`}>{(id) => <input id={id} type="number" min={1} max={freq === "daily" ? 365 : freq === "weekly" ? 52 : 24} required value={interval} onChange={(e) => setIntervalN(Number(e.target.value) || 1)} />}</Field>
        </div>
        {freq === "weekly" && (
          <fieldset style={{ border: 0, padding: 0, margin: "0 0 0.85rem" }}>
            <legend className="label">{t("ui.on_weekdays")}</legend>
            <div className="row">{WEEK_ORDER.map((d) => <label key={d} className="row" style={{ gap: "0.3rem" }}><input type="checkbox" checked={weekdays.includes(d)} onChange={(e) => setWeekdays(e.target.checked ? [...weekdays, d] : weekdays.filter((x) => x !== d))} />{weekday(d)}</label>)}</div>
          </fieldset>
        )}
        {freq === "monthly" && <Field label={t("ui.day_of_month")}>{(id) => <input id={id} type="number" min={1} max={31} required value={dayOfMonth} onChange={(e) => setDayOfMonth(Number(e.target.value) || 1)} />}</Field>}
        <div className="grid cols-2">
          <Field label={t("ui.starts")}>{(id) => <input id={id} type="date" required value={startDate} onChange={(e) => setStartDate(e.target.value)} />}</Field>
          <Field label={t("ui.ends")}>{(id) => <input id={id} type="date" value={endDate} min={startDate} onChange={(e) => setEndDate(e.target.value)} />}</Field>
          <Field label={t("ui.max_occurrences")}>{(id) => <input id={id} type="number" min={1} max={1000} value={max} onChange={(e) => setMax(e.target.value)} />}</Field>
          <Field label={t("ui.due_offset")}>{(id) => <input id={id} type="number" min={0} max={365} value={dueOffset} onChange={(e) => setDueOffset(e.target.value)} />}</Field>
          <Field label={t("ui.reminder")}>{(id) => <select id={id} value={reminder} onChange={(e) => setReminder(e.target.value)}><option value="">{t("ui.reminder_none")}</option>{[0, 1, 2, 3, 7].map((n) => <option key={n} value={n}>{t("ui.reminder_days", { n })}</option>)}</select>}</Field>
        </div>
        {series && <label className="row" style={{ gap: "0.4rem", marginBottom: "0.85rem" }}><input type="checkbox" checked={applyFuture} onChange={(e) => setApplyFuture(e.target.checked)} />{t("ui.apply_future")}</label>}
        <div className="row"><Btn type="submit" kind="primary" disabled={busy || !title.trim() || (freq === "weekly" && weekdays.length === 0)}>{t("ui.save")}</Btn><Btn onClick={onClose}>{t("ui.cancel")}</Btn></div>
      </form>
    </Modal>
  );
}
