"use client";
import { useMemo, useState } from "react";
import { addDays, diffDays } from "@/domain/time";
import { api } from "../api";
import { Btn, Empty, ErrorNote, Loading } from "../components";
import { useQuery } from "../hooks";
import { useChangeSignal } from "../signals";
import { useI18n } from "../i18n";
import { useOrg } from "../org";
import type { Filters, TaskSummary } from "./model";
import { useToday } from "./shared";

interface Resp { items: TaskSummary[]; edges: { taskId: string; prerequisiteId: string }[]; hasMore: boolean }
const ROW = 36;

/**
 * Gantt-style timeline. Same data and permissions as every other view. Limitations (also shown on screen):
 * tasks without any date are omitted; a task with one date is a single-day bar; dependency arrows are drawn only
 * between tasks that are both in the visible window.
 */
export function TimelineView({ filters, onOpen, version }: { filters: Filters; onOpen: (id: string) => void; version: number }) {
  const { orgId } = useOrg();
  const { t, date } = useI18n();
  const today = useToday();
  const [zoom, setZoom] = useState<"week" | "month">("week");
  const [anchor, setAnchor] = useState(() => addDays(today, -7));
  const span = zoom === "week" ? 84 : 365;
  const dayPx = zoom === "week" ? 22 : 5;
  const from = anchor, to = addDays(anchor, span);
  const qs = new URLSearchParams({ from, to, ...(filters.project ? { projectId: filters.project } : {}), ...(filters.assignee ? { assignee: filters.assignee } : {}) }).toString();
  const sig = useChangeSignal(orgId);
  const q = useQuery<Resp>(`tl:${orgId}:${qs}:${version}`, () => api<Resp>(`/api/orgs/${orgId}/timeline?${qs}`), { signal: sig.tasks, refreshMs: 300_000 });

  const rows = useMemo(() => {
    const items = q.data?.items ?? [];
    const byId = new Map(items.map((i) => [i.id, i]));
    const children = new Map<string, TaskSummary[]>();
    const roots: TaskSummary[] = [];
    for (const i of items) { if (i.parentId && byId.has(i.parentId)) (children.get(i.parentId) ?? children.set(i.parentId, []).get(i.parentId)!).push(i); else roots.push(i); }
    const out: { task: TaskSummary; depth: number }[] = [];
    const walk = (t0: TaskSummary, depth: number) => { out.push({ task: t0, depth }); for (const c of children.get(t0.id) ?? []) walk(c, depth + 1); };
    roots.forEach((r) => walk(r, 0));
    return out;
  }, [q.data]);

  const x = (d: string) => diffDays(d, from) * dayPx;
  const width = span * dayPx;
  const ticks = Array.from({ length: zoom === "week" ? 13 : 12 }, (_, i) => (zoom === "week" ? addDays(from, i * 7) : addDays(from, Math.round(i * 30.4)))).map((d) => ({ d, left: x(d) }));
  const pos = new Map(rows.map((r, i) => [r.task.id, { i, start: r.task.startDate ?? r.task.dueDate!, end: r.task.dueDate ?? r.task.startDate! }]));

  return (
    <div className="stack">
      <div className="row between">
        <div className="row">
          <Btn small onClick={() => setAnchor(addDays(anchor, -span / 2))} aria-label={t("ui.previous")}>‹</Btn>
          <Btn small onClick={() => setAnchor(addDays(today, -7))}>{t("ui.today")}</Btn>
          <Btn small onClick={() => setAnchor(addDays(anchor, span / 2))} aria-label={t("ui.next")}>›</Btn>
        </div>
        <div className="row" role="group" aria-label="zoom">
          <Btn small aria-pressed={zoom === "week"} onClick={() => setZoom("week")}>{t("ui.zoom_week")}</Btn>
          <Btn small aria-pressed={zoom === "month"} onClick={() => setZoom("month")}>{t("ui.zoom_month")}</Btn>
        </div>
      </div>
      <p className="muted small">{t("ui.timeline_note")}</p>
      {q.error && <ErrorNote error={q.error} onRetry={q.reload} />}
      {q.loading && !q.data && <Loading />}
      {q.data && rows.length === 0 && <Empty />}
      {rows.length > 0 && (
        <div className="tl" role="table" aria-label={t("ui.timeline")}>
          <div style={{ minWidth: 220 + width, position: "relative" }}>
            <div className="tl-row tl-head" role="row">
              <div className="tl-label" role="columnheader" />
              <div className="tl-track" role="columnheader" style={{ width }}>
                {ticks.map((tk) => <span key={tk.d} className="tl-tick" style={{ left: tk.left }}>{date(tk.d)}</span>)}
              </div>
            </div>
            <div style={{ position: "relative" }}>
              {rows.map(({ task, depth }) => {
                const p = pos.get(task.id)!;
                const left = Math.max(0, x(p.start)), right = Math.min(width, x(addDays(p.end, 1)));
                return (
                  <div key={task.id} className="tl-row" role="row">
                    <div className="tl-label" role="rowheader" style={{ paddingLeft: 8 + depth * 14 }}><button className="task-title truncate" onClick={() => onOpen(task.id)}>{task.title}</button></div>
                    <div className="tl-track" role="cell" style={{ width }}>
                      {x(today) >= 0 && x(today) <= width && <span className="tl-today" style={{ left: x(today) }} aria-hidden="true" />}
                      <button className="tl-bar" data-s={task.status} style={{ left, width: Math.max(dayPx, right - left) }} onClick={() => onOpen(task.id)} aria-label={`${task.title}: ${date(p.start)} – ${date(p.end)}`}>{dayPx * 3 < right - left ? task.title : ""}</button>
                    </div>
                  </div>
                );
              })}
              <svg style={{ position: "absolute", left: 220, top: 0, width, height: rows.length * ROW, pointerEvents: "none", zIndex: 2 }} aria-hidden="true">
                <defs><marker id="arr" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 z" fill="currentColor" /></marker></defs>
                {(q.data?.edges ?? []).map((e) => {
                  const a = pos.get(e.prerequisiteId), b = pos.get(e.taskId);
                  if (!a || !b) return null;
                  const x1 = Math.min(width, x(addDays(a.end, 1))), y1 = a.i * ROW + ROW / 2, x2 = Math.max(0, x(b.start)), y2 = b.i * ROW + ROW / 2;
                  return <path key={`${e.taskId}-${e.prerequisiteId}`} d={`M${x1},${y1} C${x1 + 14},${y1} ${x2 - 14},${y2} ${x2},${y2}`} stroke="currentColor" fill="none" strokeWidth="1.5" markerEnd="url(#arr)" style={{ color: "var(--muted)" }} />;
                })}
              </svg>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
