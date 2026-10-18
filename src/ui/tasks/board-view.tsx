"use client";
import { useState } from "react";
import { TASK_STATUSES, type TaskStatus } from "@/domain/workflow";
import { api } from "../api";
import { Empty, ErrorNote, Loading, PriorityBadge } from "../components";
import { useQuery } from "../hooks";
import { useChangeSignal } from "../signals";
import { useI18n } from "../i18n";
import { useOrg } from "../org";
import { isOverdue, toApiQuery, type Filters, type TaskSummary } from "./model";
import { StatusSelect, useStatusChange, useToday } from "./shared";

/**
 * Kanban board. Dragging a card changes its status through the same server-validated endpoint as every other
 * view; each card also has a "move to" select so the board is fully usable with keyboard and touch.
 */
export function BoardView({ filters, onOpen, version, onChanged }: { filters: Filters; onOpen: (id: string) => void; version: number; onChanged: () => void }) {
  const { orgId } = useOrg();
  const { t, date } = useI18n();
  const today = useToday();
  const sig = useChangeSignal(orgId);
  const q = useQuery<{ items: TaskSummary[]; hasMore: boolean }>(`board:${orgId}:${toApiQuery(filters)}:${version}`, () => api(`/api/orgs/${orgId}/tasks?${toApiQuery(filters, { limit: 100, sort: filters.sort ?? "priority" })}`), { signal: sig.tasks, refreshMs: 300_000 });
  const { change, busy } = useStatusChange(onChanged);
  const [over, setOver] = useState<TaskStatus | null>(null);
  if (q.loading && !q.data) return <Loading />;
  if (q.error && !q.data) return <ErrorNote error={q.error} onRetry={q.reload} />;
  const items = q.data?.items ?? [];
  const visible = filters.status.length ? TASK_STATUSES.filter((s) => filters.status.includes(s)) : TASK_STATUSES;

  return (
    <div className="stack">
      {items.length === 0 && <Empty />}
      <div className="board" role="list" aria-label={t("ui.board")}>
        {visible.map((status) => {
          const col = items.filter((i) => i.status === status);
          return (
            <section key={status} role="listitem" className="column" data-over={over === status} aria-label={t(`status.${status}` as never)}
              onDragOver={(e) => { e.preventDefault(); setOver(status); }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData("text/task"); const task = items.find((i) => i.id === id); if (task && task.status !== status) void change(task, status); }}>
              <h3><span>{t(`status.${status}` as never)}</span><span className="muted small">{col.length}</span></h3>
              {col.map((task) => (
                <article key={task.id} className="tcard" draggable={task.perms.changeStatus} onDragStart={(e) => e.dataTransfer.setData("text/task", task.id)}>
                  <button className="task-title" onClick={() => onOpen(task.id)}>{task.title}</button>
                  <div className="row small" style={{ margin: "0.35rem 0" }}>
                    <PriorityBadge priority={task.priority} />
                    {task.dueDate && <span className={isOverdue(task.dueDate, task.status, today) ? "overdue" : "muted"}>{date(task.dueDate)}</span>}
                    {task.blockedByCount > 0 && <span className="badge" data-s="blocked">■ {task.blockedByCount}</span>}
                  </div>
                  <div className="row between small">
                    <span className="muted truncate" style={{ maxWidth: "50%" }}>{task.assignees.map((a) => a.name).join(", ") || t("ui.unassigned")}</span>
                    <StatusSelect task={task} busy={busy === task.id} onChange={(to) => void change(task, to)} />
                  </div>
                </article>
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
