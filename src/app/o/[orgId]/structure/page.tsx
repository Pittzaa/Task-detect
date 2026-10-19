"use client";
import { useState } from "react";
import { RETENTION } from "@/domain/retention";
import { api } from "@/ui/api";
import { Btn, Empty, ErrorNote, Field, Loading, Modal, useToast, useTypedConfirm } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";

interface Dept { id: string; name: string }
interface Team { id: string; name: string; departmentId: string }
interface Proj { id: string; name: string }

function AddForm({ label, onAdd, extra }: { label: string; onAdd: (name: string) => Promise<void>; extra?: React.ReactNode }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  return (
    <form className="row" style={{ alignItems: "flex-end" }} onSubmit={async (e) => { e.preventDefault(); await onAdd(name.trim()); setName(""); }}>
      {extra}
      <Field label={label}>{(id) => <input id={id} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
      <div className="field"><Btn type="submit" kind="primary">{t("ui.create")}</Btn></div>
    </form>
  );
}

export default function StructurePage() {
  const { orgId, can } = useOrg();
  const { t, err } = useI18n();
  const toast = useToast();
  const confirmDelete = useTypedConfirm();
  const depts = useQuery<{ departments: Dept[] }>(`depts:${orgId}`, () => api(`/api/orgs/${orgId}/departments`));
  const teams = useQuery<{ teams: Team[] }>(`teams:${orgId}`, () => api(`/api/orgs/${orgId}/teams`));
  const projects = useQuery<{ projects: Proj[] }>(`projects:${orgId}`, () => api(`/api/orgs/${orgId}/projects`));
  const [deptForTeam, setDeptForTeam] = useState("");
  // the department a new team goes into: the chosen one while it still exists, otherwise the first (a deleted one must not stay selected)
  const effectiveDept = depts.data?.departments.find((d) => d.id === deptForTeam)?.id ?? depts.data?.departments[0]?.id ?? "";
  const [editProject, setEditProject] = useState<Proj>();
  const [selected, setSelected] = useState<string[]>([]);

  async function guard(fn: () => Promise<unknown>) { try { await fn(); depts.reload(); teams.reload(); projects.reload(); } catch (e) { toast(err(e), "error"); } }
  /** Deleting asks for the name to be typed; the server checks it again and does the cleaning up (deleteDepartment, deleteTeam, deleteProject). */
  function remove(path: string, name: string, body: string) {
    confirmDelete.ask({
      phrase: name,
      body,
      run: async (typed) => { await api(path, { method: "DELETE", body: { confirm: typed } }); toast(t("ui.deleted_ok")); depts.reload(); teams.reload(); projects.reload(); },
    });
  }
  async function openProject(p: Proj) {
    try { const d = await api<{ teamIds: string[] }>(`/api/orgs/${orgId}/projects/${p.id}`); setSelected(d.teamIds); setEditProject(p); } catch (e) { toast(err(e), "error"); }
  }

  if (depts.loading && !depts.data) return <Loading />;
  if (depts.error) return <ErrorNote error={depts.error} onRetry={depts.reload} />;
  return (
    <div className="stack">
      <h1>{t("ui.structure")}</h1>
      <section className="card" aria-labelledby="h-d">
        <h2 id="h-d">{t("ui.departments")}</h2>
        <ul>{depts.data?.departments.map((d) => (
          <li key={d.id}>{d.name} {can.manageDepartments && <Btn small kind="danger" aria-label={`${t("ui.delete")}: ${d.name}`} onClick={() => remove(`/api/orgs/${orgId}/departments/${d.id}`, d.name, t("ui.confirm_delete_department", { name: d.name, teams: teams.data?.teams.filter((x) => x.departmentId === d.id).length ?? 0 }))}>{t("ui.delete")}</Btn>}</li>
        ))}</ul>
        {!depts.data?.departments.length && <Empty />}
        {can.manageDepartments && <AddForm label={t("ui.new_department")} onAdd={(name) => guard(() => api(`/api/orgs/${orgId}/departments`, { method: "POST", body: { name } }))} />}
      </section>
      <section className="card" aria-labelledby="h-t">
        <h2 id="h-t">{t("ui.teams")}</h2>
        <ul>{teams.data?.teams.map((x) => (
          <li key={x.id}>{x.name} <span className="muted small">· {depts.data?.departments.find((d) => d.id === x.departmentId)?.name}</span> {can.manageTeams && <Btn small kind="danger" aria-label={`${t("ui.delete")}: ${x.name}`} onClick={() => remove(`/api/orgs/${orgId}/teams/${x.id}`, x.name, t("ui.confirm_delete_team", { name: x.name }))}>{t("ui.delete")}</Btn>}</li>
        ))}</ul>
        {!teams.data?.teams.length && <Empty />}
        {can.manageTeams && (
          <AddForm label={t("ui.new_team")} onAdd={(name) => guard(() => api(`/api/orgs/${orgId}/teams`, { method: "POST", body: { name, departmentId: effectiveDept } }))}
            extra={<Field label={t("ui.departments")}>{(id) => <select id={id} value={effectiveDept} onChange={(e) => setDeptForTeam(e.target.value)}>{depts.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}</Field>} />
        )}
      </section>
      <section className="card" aria-labelledby="h-p">
        <h2 id="h-p">{t("ui.projects")}</h2>
        <ul>{projects.data?.projects.map((p) => (
          <li key={p.id}>{p.name} {can.createProject && <Btn small onClick={() => void openProject(p)}>{t("ui.project_teams")}</Btn>} {can.deleteProject && <Btn small kind="danger" aria-label={`${t("ui.delete")}: ${p.name}`} onClick={() => remove(`/api/orgs/${orgId}/projects/${p.id}`, p.name, t("ui.confirm_delete_project", { name: p.name, days: RETENTION.trashDays }))}>{t("ui.delete")}</Btn>}</li>
        ))}</ul>
        {!projects.data?.projects.length && <Empty />}
        {can.createProject && <AddForm label={t("ui.new_project")} onAdd={(name) => guard(() => api(`/api/orgs/${orgId}/projects`, { method: "POST", body: { name } }))} />}
      </section>
      {confirmDelete.dialog}
      <Modal open={!!editProject} onClose={() => setEditProject(undefined)} title={`${t("ui.project_teams")}: ${editProject?.name ?? ""}`}>
        <div className="stack">
          {teams.data?.teams.map((x) => <label key={x.id} className="row" style={{ gap: "0.4rem" }}><input type="checkbox" checked={selected.includes(x.id)} onChange={(e) => setSelected(e.target.checked ? [...selected, x.id] : selected.filter((i) => i !== x.id))} />{x.name}</label>)}
          <Btn kind="primary" onClick={() => void guard(async () => { await api(`/api/orgs/${orgId}/projects/${editProject!.id}/teams`, { method: "PUT", body: { teamIds: selected } }); setEditProject(undefined); })}>{t("ui.save")}</Btn>
        </div>
      </Modal>
    </div>
  );
}
