"use client";
import { useEffect, useState } from "react";
import { TASK_PRIORITIES, type TaskPriority } from "@/domain/workflow";
import { api, ApiError } from "../api";
import { Btn, Field, Modal, Notice } from "../components";
import { useI18n } from "../i18n";
import { useOrg } from "../org";
import type { Person, Project } from "./shared";

export function NewTaskModal({ open, onClose, projects, defaultProject, onCreated }: { open: boolean; onClose: () => void; projects: Project[]; defaultProject?: string; onCreated: (id: string) => void }) {
  const { orgId } = useOrg();
  const { t, err } = useI18n();
  const [chosenProject, setProject] = useState("");
  const project = chosenProject || defaultProject || projects[0]?.id || "";
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<TaskPriority>("medium");
  const [start, setStart] = useState("");
  const [due, setDue] = useState("");
  const [assignee, setAssignee] = useState("");
  const [people, setPeople] = useState<Person[]>([]);
  const [error, setError] = useState<string>();
  const [dueErr, setDueErr] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !project) return;
    void api<{ people: Person[] }>(`/api/orgs/${orgId}/projects/${project}/people`).then((r) => setPeople(r.people)).catch(() => setPeople([]));
  }, [open, project, orgId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError(undefined); setDueErr(undefined);
    try {
      const r = await api<{ id: string }>(`/api/orgs/${orgId}/tasks`, { method: "POST", body: { projectId: project, title, description: description || undefined, priority, startDate: start || null, dueDate: due || null, primaryAssigneeId: assignee || null } });
      setTitle(""); setDescription(""); setStart(""); setDue(""); setAssignee("");
      onCreated(r.id);
    } catch (e2) {
      if (e2 instanceof ApiError && e2.message === "val.date_range") setDueErr(t("val.date_range"));
      else setError(err(e2));
    } finally { setBusy(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title={t("ui.new_task")}>
      <form onSubmit={submit}>
        {error && <Notice kind="error">{error}</Notice>}
        <Field label={t("ui.project")}>{(id) => <select id={id} required value={project} onChange={(e) => setProject(e.target.value)}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
        <Field label={t("ui.title")}>{(id) => <input id={id} required maxLength={300} value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: "100%" }} />}</Field>
        <Field label={t("ui.description")}>{(id) => <textarea id={id} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>
        <div className="grid cols-2">
          <Field label={t("ui.priority")}>{(id) => <select id={id} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{t(`priority.${p}` as never)}</option>)}</select>}</Field>
          <Field label={t("ui.assignee")}>{(id) => <select id={id} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">{t("ui.unassigned")}</option>{people.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>}</Field>
          <Field label={t("ui.start")}>{(id) => <input id={id} type="date" value={start} onChange={(e) => setStart(e.target.value)} />}</Field>
          <Field label={t("ui.due")} error={dueErr}>{(id, d) => <input id={id} aria-describedby={d} aria-invalid={!!dueErr} type="date" value={due} onChange={(e) => setDue(e.target.value)} />}</Field>
        </div>
        <div className="row"><Btn type="submit" kind="primary" disabled={busy || !project}>{t("ui.create")}</Btn><Btn onClick={onClose}>{t("ui.cancel")}</Btn></div>
      </form>
    </Modal>
  );
}
