"use client";
import { useState } from "react";
import { addDays, weekdayOf } from "@/domain/time";
import { api } from "../api";
import { Btn, ErrorNote, Loading } from "../components";
import { useQuery } from "../hooks";
import { useChangeSignal } from "../signals";
import { useI18n } from "../i18n";
import { useOrg } from "../org";
import { toApiQuery, type Filters, type TaskSummary } from "./model";
import { useToday } from "./shared";

const ymd = (y: number, m0: number, d: number) => `${String(y).padStart(4, "0")}-${String(m0 + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** Month grid (weeks start on Monday). A task appears on every day of its start-to-due span, or on its single date. */
export function CalendarView({ filters, onOpen, version }: { filters: Filters; onOpen: (id: string) => void; version: number }) {
  const { orgId } = useOrg();
  const { t, locale } = useI18n();
  const today = useToday();
  const [cursor, setCursor] = useState(() => { const [y, m] = today.split("-").map(Number) as [number, number]; return { y, m0: m - 1 }; });

  const first = ymd(cursor.y, cursor.m0, 1);
  const lead = (weekdayOf(first) + 6) % 7; // Monday = 0
  const gridStart = addDays(first, -lead);
  const days = Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
  const gridEnd = days[41]!;

  const qs = toApiQuery({ ...filters, dueFrom: undefined, dueTo: undefined }, { rangeFrom: gridStart, rangeTo: gridEnd, limit: 100, sort: "due" });
  const sig = useChangeSignal(orgId);
  const q = useQuery<{ items: TaskSummary[] }>(`cal:${orgId}:${qs}:${version}`, () => api(`/api/orgs/${orgId}/tasks?${qs}`), { signal: sig.tasks, refreshMs: 300_000 });

  const byDay = new Map<string, TaskSummary[]>();
  for (const task of q.data?.items ?? []) {
    const start = task.startDate ?? task.dueDate!;
    const end = task.dueDate ?? task.startDate!;
    for (let d = start < gridStart ? gridStart : start; d <= (end > gridEnd ? gridEnd : end); d = addDays(d, 1)) (byDay.get(d) ?? byDay.set(d, []).get(d)!).push(task);
  }

  const fmt = new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  const dow = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(locale === "th" ? "th-TH" : "en-GB", { weekday: "short", timeZone: "UTC" }).format(new Date(`${addDays("2026-03-02", i)}T00:00:00Z`)));
  const move = (delta: number) => setCursor((c) => { const n = c.m0 + delta; return { y: c.y + Math.floor(n / 12), m0: ((n % 12) + 12) % 12 }; });

  return (
    <div className="stack">
      <div className="row between">
        <h2 style={{ margin: 0 }} aria-live="polite">{fmt.format(new Date(`${first}T00:00:00Z`))}</h2>
        <div className="row">
          <Btn small onClick={() => move(-1)} aria-label={t("ui.prev_month")}>‹</Btn>
          <Btn small onClick={() => { const [y, m] = today.split("-").map(Number) as [number, number]; setCursor({ y, m0: m - 1 }); }}>{t("ui.today")}</Btn>
          <Btn small onClick={() => move(1)} aria-label={t("ui.next_month")}>›</Btn>
        </div>
      </div>
      {q.error && <ErrorNote error={q.error} onRetry={q.reload} />}
      {q.loading && !q.data && <Loading />}
      <div className="cal" role="grid" aria-label={t("ui.calendar")}>
        <div className="week" role="row">{dow.map((d) => <div key={d} className="dow" role="columnheader">{d}</div>)}</div>
        {Array.from({ length: 6 }, (_, w) => (
          <div key={w} className="week" role="row">
            {days.slice(w * 7, w * 7 + 7).map((d) => {
              const list = byDay.get(d) ?? [];
              return (
                <div key={d} className="day" role="gridcell" data-out={d.slice(0, 7) !== first.slice(0, 7)} data-today={d === today}>
                  <span className="num small">{Number(d.slice(8))}</span>
                  {list.slice(0, 3).map((task) => <button key={task.id} className="chip" onClick={() => onOpen(task.id)} title={task.title}>{task.title}</button>)}
                  {list.length > 3 && <span className="muted small">+{list.length - 3}</span>}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
