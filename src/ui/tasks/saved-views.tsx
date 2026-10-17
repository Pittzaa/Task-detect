"use client";
import { useState } from "react";
import { api } from "../api";
import { Btn, Field, Modal, useToast } from "../components";
import { useQuery } from "../hooks";
import { useI18n } from "../i18n";
import { useOrg } from "../org";
import type { Filters } from "./model";

interface ViewRow { id: string; name: string; kind: string; scope: "personal" | "team" | "organization"; editable: boolean }

/** Converts the UI filters to the stored (and server-validated) view filter definition. */
export function toViewFilter(f: Filters) {
  return {
    ...(f.project ? { projectId: f.project } : {}), ...(f.status.length ? { status: f.status } : {}), ...(f.priority.length ? { priority: f.priority } : {}),
    ...(f.assignee ? { assignee: f.assignee } : {}), ...(f.label ? { labelId: f.label } : {}), ...(f.q ? { q: f.q } : {}), ...(f.overdue ? { overdue: true } : {}),
    ...(f.topLevel ? { topLevelOnly: true } : {}), ...(f.sort ? { sort: f.sort } : {}), ...(f.order ? { order: f.order } : {}), ...(f.dueFrom ? { dueFrom: f.dueFrom } : {}), ...(f.dueTo ? { dueTo: f.dueTo } : {}),
  };
}

export function fromViewFilter(v: Record<string, unknown>, view: Filters["view"]): Filters {
  return {
    view, project: v.projectId as string | undefined, status: (v.status as Filters["status"]) ?? [], priority: (v.priority as Filters["priority"]) ?? [], assignee: v.assignee as string | undefined,
    label: v.labelId as string | undefined, q: v.q as string | undefined, overdue: v.overdue as boolean | undefined, topLevel: v.topLevelOnly as boolean | undefined,
    sort: v.sort as Filters["sort"], order: v.order as Filters["order"], dueFrom: v.dueFrom as string | undefined, dueTo: v.dueTo as string | undefined,
  };
}

export function SavedViews({ filters, onApply }: { filters: Filters; onApply: (f: Filters) => void }) {
  const { orgId, can } = useOrg();
  const { t, err } = useI18n();
  const toast = useToast();
  const views = useQuery<{ views: ViewRow[] }>(`views:${orgId}`, () => api(`/api/orgs/${orgId}/views`));
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<"personal" | "team" | "organization">("personal");
  const teams = useQuery<{ teams: { id: string; name: string }[] }>(open && scope === "team" ? `teams:${orgId}` : null, () => api(`/api/orgs/${orgId}/teams`));
  const [teamId, setTeamId] = useState("");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await api(`/api/orgs/${orgId}/views`, { method: "POST", body: { name, kind: filters.view === "list" ? "list" : filters.view, scope, teamId: scope === "team" ? teamId : null, filter: toViewFilter(filters) } });
      setOpen(false); setName(""); views.reload();
    } catch (e2) { toast(err(e2), "error"); }
  }

  return (
    <div className="row">
      <label className="row"><span className="sr-only">{t("ui.views")}</span>
        <select value="" onChange={async (e) => {
          const id = e.target.value; if (!id) return;
          try {
            // Results are computed for *you*; the stored definition only supplies the filters.
            const v = await api<{ filter: Record<string, unknown>; kind: string }>(`/api/orgs/${orgId}/views/${id}`);
            onApply(fromViewFilter(v.filter, (v.kind === "my_tasks" ? "list" : v.kind) as Filters["view"]));
          } catch (e2) { toast(err(e2), "error"); }
        }}>
          <option value="">{t("ui.views")}</option>
          {views.data?.views.map((v) => <option key={v.id} value={v.id}>{v.name} · {t(v.scope === "personal" ? "ui.scope_personal" : v.scope === "team" ? "ui.scope_team" : "ui.scope_org")}</option>)}
        </select>
      </label>
      <Btn small onClick={() => setOpen(true)}>{t("ui.save_view")}</Btn>
      <Modal open={open} onClose={() => setOpen(false)} title={t("ui.save_view")}>
        <form onSubmit={save}>
          <Field label={t("ui.view_name")}>{(id) => <input id={id} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label={t("ui.view_scope")}>{(id) => (
            <select id={id} value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
              <option value="personal">{t("ui.scope_personal")}</option>
              <option value="team">{t("ui.scope_team")}</option>
              {can.shareOrgViews && <option value="organization">{t("ui.scope_org")}</option>}
            </select>
          )}</Field>
          {scope === "team" && <Field label={t("ui.teams")}>{(id) => <select id={id} required value={teamId} onChange={(e) => setTeamId(e.target.value)}><option value="" />{teams.data?.teams.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}</Field>}
          <Btn type="submit" kind="primary">{t("ui.save")}</Btn>
        </form>
      </Modal>
    </div>
  );
}
