"use client";
import { useState } from "react";
import { TASK_STATUSES, allowedTransitions, type TaskStatus } from "@/domain/workflow";
import { api } from "../api";
import { useToast } from "../components";
import { useI18n } from "../i18n";
import { useOrg } from "../org";
import type { TaskSummary } from "./model";

export interface Project { id: string; name: string }
export interface Label { id: string; name: string; color: string }
export interface Person { id: string; name: string }

/** Today's calendar date in the user's time zone. */
export function useToday(): string {
  const { timezone } = useI18n();
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
}

export function useStatusChange(onDone: () => void) {
  const { orgId } = useOrg();
  const { err } = useI18n();
  const toast = useToast();
  const [busy, setBusy] = useState<string>();
  async function change(task: Pick<TaskSummary, "id">, to: TaskStatus) {
    setBusy(task.id);
    try {
      await api(`/api/orgs/${orgId}/tasks/${task.id}/status`, { method: "POST", body: { status: to } });
      onDone();
    } catch (e) {
      toast(err(e), "error");
      onDone(); // refresh so the UI reflects the server state
    } finally { setBusy(undefined); }
  }
  return { change, busy };
}

/** A status dropdown containing only legal moves for this task and this user. */
export function StatusSelect({ task, onChange, busy }: { task: TaskSummary; onChange: (to: TaskStatus) => void; busy?: boolean }) {
  const { t } = useI18n();
  const options = allowedTransitions(task.status, { canChange: task.perms.changeStatus, canReopen: task.perms.reopen });
  return (
    <select aria-label={`${t("ui.status")}: ${task.title}`} value={task.status} disabled={busy || options.length === 0} onChange={(e) => onChange(e.target.value as TaskStatus)} style={{ minHeight: 32, padding: "0.15rem 0.4rem" }}>
      <option value={task.status}>{t(`status.${task.status}` as never)}</option>
      {TASK_STATUSES.filter((s) => options.includes(s)).map((s) => <option key={s} value={s}>→ {t(`status.${s}` as never)}</option>)}
    </select>
  );
}

export const nameOf = (a: { name: string } | undefined | null) => a?.name || "—";
export const initials = (name: string) => name.split(/\s+/).map((w) => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();
