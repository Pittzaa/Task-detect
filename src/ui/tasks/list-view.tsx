"use client";
import { useState } from "react";
import { TASK_PRIORITIES, TASK_STATUSES, type TaskPriority, type TaskStatus } from "@/domain/workflow";
import { api, ApiError } from "../api";
import { Btn, Empty, ErrorNote, Loading, Notice, PriorityBadge, StatusBadge, TableWrap, useToast } from "../components";
import { useQuery } from "../hooks";
import { useChangeSignal } from "../signals";
import { useI18n } from "../i18n";
import { useOrg } from "../org";
import { isOverdue, toApiQuery, type Filters, type TaskSummary } from "./model";
import { StatusSelect, useStatusChange, useToday, type Project } from "./shared";

interface Page { items: TaskSummary[]; hasMore: boolean }
interface BulkResp { results: { taskId: string; ok: boolean; code?: string }[]; succeeded: number; failed: number }

export function ListView({ filters, projects, onOpen, version, onChanged }: { filters: Filters; projects: Project[]; onOpen: (id: string) => void; version: number; onChanged: () => void }) {
  const { orgId } = useOrg();
  const { t, date, err } = useI18n();
  const toast = useToast();
  const today = useToday();
  const query = toApiQuery(filters);
  const sig = useChangeSignal(orgId);
  const q = useQuery<Page>(`list:${orgId}:${query}:${version}`, () => api<Page>(`/api/orgs/${orgId}/tasks?${toApiQuery(filters, { limit: 50 })}`), { signal: sig.tasks, refreshMs: 300_000 });
  const { change, busy } = useStatusChange(onChanged);
  // Extra pages ("load more") are tied to the first-page response they extend; a refresh drops them.
  const [more, setMore] = useState<{ base: Page; items: TaskSummary[]; hasMore: boolean }>();
  const [loadingMore, setLoadingMore] = useState(false);
  const extra = more && more.base === q.data ? more : undefined;
  const rows = [...(q.data?.items ?? []), ...(extra?.items ?? [])];
  const hasMore = extra ? extra.hasMore : !!q.data?.hasMore;

  async function loadMore() {
    if (!q.data) return;
    setLoadingMore(true);
    try {
      const next = await api<Page>(`/api/orgs/${orgId}/tasks?${toApiQuery(filters, { limit: 50, offset: rows.length })}`);
      setMore({ base: q.data, items: [...(extra?.items ?? []), ...next.items.filter((n) => !rows.some((r) => r.id === n.id))], hasMore: next.hasMore });
    } catch (e) { toast(err(e), "error"); } finally { setLoadingMore(false); }
  }

  // bulk selection (state resets because the page remounts this component whenever the filters change)
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<"status" | "priority" | "dueDate" | "assignee">("status");
  const [value, setValue] = useState("");
  const [result, setResult] = useState<BulkResp>();
  const [bulkBusy, setBulkBusy] = useState(false);
  const projectName = new Map(projects.map((p) => [p.id, p.name]));
  const titleOf = new Map(rows.map((r) => [r.id, r.title]));

  async function applyBulk() {
    setBulkBusy(true); setResult(undefined);
    try {
      const act = action === "status" ? { type: "status", status: value } : action === "priority" ? { type: "priority", priority: value } : action === "dueDate" ? { type: "dueDate", dueDate: value || null } : { type: "assignee", userId: value === "me" ? undefined : value || null };
      const body = { taskIds: [...selected], action: act.type === "assignee" && act.userId === undefined ? undefined : act };
      if (!body.action) { toast(t("ui.assignee_any"), "error"); return; }
      const r = await api<BulkResp>(`/api/orgs/${orgId}/tasks/bulk`, { method: "POST", body });
      setResult(r); setSelected(new Set()); onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.data && Array.isArray((e.data as { results?: unknown }).results)) setResult({ results: (e.data as { results: BulkResp["results"] }).results, succeeded: 0, failed: selected.size });
      toast(err(e), "error");
    } finally { setBulkBusy(false); }
  }

  if (q.loading) return <Loading />;
  if (q.error && !q.data) return <ErrorNote error={q.error} onRetry={q.reload} />;
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));

  return (
    <div className="stack">
      {selected.size > 0 && (
        <div className="card row" role="region" aria-label={t("ui.selected", { n: selected.size })}>
          <strong>{t("ui.selected", { n: selected.size })}</strong>
          <select aria-label={t("ui.action")} value={action} onChange={(e) => { setAction(e.target.value as typeof action); setValue(""); }}>
            <option value="status">{t("ui.status")}</option><option value="priority">{t("ui.priority")}</option><option value="dueDate">{t("ui.due")}</option>
          </select>
          {action === "status" && <select aria-label={t("ui.status")} value={value} onChange={(e) => setValue(e.target.value)}><option value="" />{TASK_STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}` as never)}</option>)}</select>}
          {action === "priority" && <select aria-label={t("ui.priority")} value={value} onChange={(e) => setValue(e.target.value)}><option value="" />{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{t(`priority.${p}` as never)}</option>)}</select>}
          {action === "dueDate" && <input type="date" aria-label={t("ui.due")} value={value} onChange={(e) => setValue(e.target.value)} />}
          <Btn kind="primary" small disabled={bulkBusy || (action !== "dueDate" && !value)} onClick={() => void applyBulk()}>{t("ui.apply")}</Btn>
        </div>
      )}
      {result && (
        <Notice kind={result.failed ? "warn" : "success"}>
          {t("ui.bulk_result", { ok: result.succeeded, failed: result.failed })}
          {result.failed > 0 && <ul style={{ margin: "0.4rem 0 0", paddingLeft: "1.1rem" }}>{result.results.filter((r) => !r.ok).map((r) => <li key={r.taskId}>{titleOf.get(r.taskId) ?? r.taskId.slice(0, 8)}: {r.code === "FORBIDDEN" ? t("error.forbidden") : r.code === "NOT_FOUND" ? t("error.not_found") : r.code === "VALIDATION" ? t("error.validation") : r.code}</li>)}</ul>}
        </Notice>
      )}
      {rows.length === 0 ? <Empty /> : (
        <TableWrap label={t("ui.tasks")}>
          <table>
            <thead>
              <tr>
                <th style={{ width: 36 }}><input type="checkbox" aria-label={t("ui.select_all")} checked={allSelected} onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>
                <th>{t("ui.title")}</th><th>{t("ui.status")}</th><th>{t("ui.priority")}</th><th>{t("ui.assignee")}</th><th>{t("ui.due")}</th><th>{t("ui.project")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="clickable">
                  <td><input type="checkbox" aria-label={r.title} checked={selected.has(r.id)} onChange={(e) => { const n = new Set(selected); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSelected(n); }} /></td>
                  <td style={{ paddingLeft: r.parentId ? "1.5rem" : undefined, minWidth: 220 }}>
                    <button className="task-title" onClick={() => onOpen(r.id)}>{r.title}</button>
                    {r.blockedByCount > 0 && <span className="badge" data-s="blocked" title={t("ui.prerequisites")} style={{ marginLeft: 6 }}>■ {r.blockedByCount}</span>}
                    {r.subtaskCount > 0 && <span className="muted small"> · {r.subtaskCount} {t("ui.subtasks")}</span>}
                  </td>
                  <td><StatusSelect task={r} busy={busy === r.id} onChange={(to: TaskStatus) => void change(r, to)} /><span className="sr-only"><StatusBadge status={r.status} /></span></td>
                  <td><PriorityBadge priority={r.priority as TaskPriority} /></td>
                  <td>{r.assignees.length ? r.assignees.map((a) => a.name).join(", ") : <span className="muted">{t("ui.unassigned")}</span>}</td>
                  <td className={isOverdue(r.dueDate, r.status, today) ? "overdue" : undefined}>{r.dueDate ? date(r.dueDate) : "—"}{isOverdue(r.dueDate, r.status, today) && <span className="sr-only"> ({t("ui.overdue")})</span>}</td>
                  <td className="muted">{projectName.get(r.projectId) ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      )}
      {hasMore && <div><Btn onClick={() => void loadMore()} disabled={loadingMore}>{t("ui.load_more")}</Btn></div>}
    </div>
  );
}
