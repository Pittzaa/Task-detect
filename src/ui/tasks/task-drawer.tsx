"use client";
import { useEffect, useMemo, useState } from "react";
import { TASK_PRIORITIES, allowedTransitions, type TaskPriority, type TaskStatus } from "@/domain/workflow";
import { MAX_UPLOAD_BYTES } from "@/domain/files";
import { allMessages } from "@/i18n";
import { api, ApiError } from "../api";
import { Btn, Drawer, Empty, ErrorNote, Field, Loading, Notice, PriorityBadge, StatusBadge, useToast } from "../components";
import { useQuery } from "../hooks";
import { useI18n } from "../i18n";
import { useOrg } from "../org";
import type { Label, Person } from "./shared";

interface Detail {
  id: string; projectId: string; parentId: string | null; title: string; description: string; status: TaskStatus; priority: TaskPriority;
  startDate: string | null; dueDate: string | null; reminderDaysBefore: number | null; version: number; seriesId: string | null;
  primaryAssigneeId: string | null; coAssigneeIds: string[]; labelIds: string[]; customFields: Record<string, unknown>;
  subtasks: { id: string; title: string; status: TaskStatus; dueDate: string | null }[];
  prerequisites: ({ id: string; title: string; status: TaskStatus; restricted: false } | { id: string; restricted: true })[];
  dependents: ({ id: string; title: string; status: TaskStatus; restricted: false } | { id: string; restricted: true })[];
  permissions: { update: boolean; changeStatus: boolean; assign: boolean; delete: boolean; comment: boolean; reopen: boolean; manageDependencies: boolean; attach: boolean };
}
interface FieldDef { id: string; name: string; type: "text" | "number" | "date" | "dropdown" | "checkbox"; options: { id: string; label: string; archived?: boolean }[]; minValue: string | null; maxValue: string | null }
interface Comment { id: string; body: string; authorId: string; authorName: string; createdAt: string; editedAt: string | null }
interface Activity { id: string; type: string; changes: Record<string, unknown>; actorId: string | null; createdAt: string }
interface Attachment { id: string; filename: string; sizeBytes: number; contentType: string; createdAt: string }

export function TaskDrawer({ taskId, onClose, onChanged, onOpen }: { taskId: string | null; onClose: () => void; onChanged: () => void; onOpen: (id: string) => void }) {
  const { orgId } = useOrg();
  const { t } = useI18n();
  const d = useQuery<Detail>(taskId ? `task:${orgId}:${taskId}` : null, () => api<Detail>(`/api/orgs/${orgId}/tasks/${taskId}`));
  return (
    <Drawer open={!!taskId} onClose={onClose} title={d.data?.title ?? t("ui.loading")}>
      {d.loading && !d.data && <Loading />}
      {d.error && <ErrorNote error={d.error} onRetry={d.reload} />}
      {d.data && <DrawerBody key={d.data.id + ":" + d.data.version} task={d.data} reload={() => { d.reload(); onChanged(); }} onClose={onClose} onOpen={onOpen} />}
    </Drawer>
  );
}

function DrawerBody({ task, reload, onClose, onOpen }: { task: Detail; reload: () => void; onClose: () => void; onOpen: (id: string) => void }) {
  const { orgId } = useOrg();
  const { t, err, date, instant, locale } = useI18n();
  const toast = useToast();
  const p = task.permissions;
  const people = useQuery<{ people: Person[] }>(`people:${orgId}:${task.projectId}`, () => api(`/api/orgs/${orgId}/projects/${task.projectId}/people`));
  const labels = useQuery<{ labels: Label[] }>(`labels:${orgId}`, () => api(`/api/orgs/${orgId}/labels`));
  const fields = useQuery<{ fields: FieldDef[] }>(`fields:${orgId}`, () => api(`/api/orgs/${orgId}/custom-fields`));
  const comments = useQuery<{ comments: Comment[] }>(`comments:${task.id}`, () => api(`/api/orgs/${orgId}/tasks/${task.id}/comments`), { refreshMs: 20_000 });
  const activity = useQuery<{ activity: Activity[] }>(`activity:${task.id}:${task.version}`, () => api(`/api/orgs/${orgId}/tasks/${task.id}/activity?limit=30`));
  const files = useQuery<{ attachments: Attachment[] }>(`files:${task.id}`, () => api(`/api/orgs/${orgId}/tasks/${task.id}/attachments`));
  const nameOf = useMemo(() => new Map((people.data?.people ?? []).map((x) => [x.id, x.name])), [people.data]);

  // ---- editable core fields
  const [form, setForm] = useState({ title: task.title, description: task.description, priority: task.priority, startDate: task.startDate ?? "", dueDate: task.dueDate ?? "", reminder: task.reminderDaysBefore === null ? "" : String(task.reminderDaysBefore) });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const dirty = form.title !== task.title || form.description !== task.description || form.priority !== task.priority || form.startDate !== (task.startDate ?? "") || form.dueDate !== (task.dueDate ?? "") || form.reminder !== (task.reminderDaysBefore === null ? "" : String(task.reminderDaysBefore));

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setFieldErrors({});
    try {
      await api(`/api/orgs/${orgId}/tasks/${task.id}`, { method: "PATCH", body: { version: task.version, title: form.title, description: form.description, priority: form.priority, startDate: form.startDate || null, dueDate: form.dueDate || null, reminderDaysBefore: form.reminder === "" ? null : Number(form.reminder) } });
      toast(t("ui.save")); reload();
    } catch (e2) {
      if (e2 instanceof ApiError && e2.code === "CONFLICT") toast(t("ui.version_conflict"), "error");
      else if (e2 instanceof ApiError && e2.message === "val.date_range") setFieldErrors({ dueDate: t("val.date_range") });
      else toast(err(e2), "error");
    } finally { setSaving(false); }
  }

  async function act<T>(fn: () => Promise<T>, ok?: string) {
    try { const r = await fn(); if (ok) toast(ok); reload(); return r; } catch (e) { toast(err(e), "error"); return undefined; }
  }

  const transitions = allowedTransitions(task.status, { canChange: p.changeStatus, canReopen: p.reopen });
  const assigneeOptions = people.data?.people ?? [];

  return (
    <div className="stack">
      <div className="row">
        <StatusBadge status={task.status} /><PriorityBadge priority={task.priority} />
        {task.seriesId && <span className="badge" data-p="low">↻ {t("ui.series_note")}</span>}
      </div>

      {transitions.length > 0 && (
        <div className="row" role="group" aria-label={t("ui.status")}>
          {transitions.map((s) => <Btn small key={s} onClick={() => void act(() => api(`/api/orgs/${orgId}/tasks/${task.id}/status`, { method: "POST", body: { status: s } }))}>→ {t(`status.${s}` as never)}</Btn>)}
        </div>
      )}
      {!p.update && <Notice>{t("ui.not_permitted")}</Notice>}

      <form onSubmit={save} className="card" aria-label={t("ui.edit")}>
        <Field label={t("ui.title")}>{(id) => <input id={id} required maxLength={300} value={form.title} disabled={!p.update} onChange={(e) => setForm({ ...form, title: e.target.value })} style={{ width: "100%" }} />}</Field>
        <Field label={t("ui.description")}>{(id) => <textarea id={id} value={form.description} disabled={!p.update} maxLength={20000} onChange={(e) => setForm({ ...form, description: e.target.value })} />}</Field>
        <div className="grid cols-2">
          <Field label={t("ui.priority")}>{(id) => (
            <select id={id} value={form.priority} disabled={!p.update} onChange={(e) => setForm({ ...form, priority: e.target.value as TaskPriority })}>{TASK_PRIORITIES.map((x) => <option key={x} value={x}>{t(`priority.${x}` as never)}</option>)}</select>
          )}</Field>
          <Field label={t("ui.reminder")}>{(id) => (
            <select id={id} value={form.reminder} disabled={!p.update} onChange={(e) => setForm({ ...form, reminder: e.target.value })}>
              <option value="">{t("ui.reminder_none")}</option>{[0, 1, 2, 3, 7].map((n) => <option key={n} value={n}>{t("ui.reminder_days", { n })}</option>)}
            </select>
          )}</Field>
          <Field label={t("ui.start")}>{(id) => <input id={id} type="date" value={form.startDate} disabled={!p.update} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />}</Field>
          <Field label={t("ui.due")} error={fieldErrors.dueDate}>{(id, dd) => <input id={id} aria-describedby={dd} aria-invalid={!!fieldErrors.dueDate} type="date" value={form.dueDate} disabled={!p.update} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />}</Field>
        </div>
        {p.update && <Btn type="submit" kind="primary" disabled={!dirty || saving}>{t("ui.save")}</Btn>}
      </form>

      {/* people */}
      <section className="card" aria-labelledby="h-people">
        <h2 id="h-people">{t("ui.assignee")}</h2>
        {p.assign || p.update ? (
          <AssigneeEditor task={task} people={assigneeOptions} canAssignOthers={p.assign} onSave={(primary, co) => void act(() => api(`/api/orgs/${orgId}/tasks/${task.id}/assignees`, { method: "PUT", body: { primary, co } }))} />
        ) : <p>{[task.primaryAssigneeId, ...task.coAssigneeIds].filter(Boolean).map((i) => nameOf.get(i!) ?? "…").join(", ") || t("ui.unassigned")}</p>}
      </section>

      {/* labels */}
      {(labels.data?.labels.length ?? 0) > 0 && (
        <section className="card" aria-labelledby="h-labels">
          <h2 id="h-labels">{t("ui.labels")}</h2>
          <div className="row">
            {labels.data!.labels.map((l) => {
              const on = task.labelIds.includes(l.id);
              return <label key={l.id} className="row" style={{ gap: "0.3rem" }}><input type="checkbox" checked={on} disabled={!p.update} onChange={() => void act(() => api(`/api/orgs/${orgId}/tasks/${task.id}/labels`, { method: "PUT", body: { labelIds: on ? task.labelIds.filter((x) => x !== l.id) : [...task.labelIds, l.id] } }))} /> <span className="badge" style={{ color: l.color }}>{l.name}</span></label>;
            })}
          </div>
        </section>
      )}

      {/* custom fields */}
      {(fields.data?.fields.length ?? 0) > 0 && <CustomFields defs={fields.data!.fields} values={task.customFields} editable={p.update} onSave={(values) => void act(() => api(`/api/orgs/${orgId}/tasks/${task.id}/custom-fields`, { method: "PUT", body: { values } }), t("ui.save"))} />}

      {/* subtasks */}
      <section className="card" aria-labelledby="h-sub">
        <h2 id="h-sub">{t("ui.subtasks")}</h2>
        {task.subtasks.length === 0 ? <Empty /> : <ul style={{ paddingLeft: "1.1rem", margin: 0 }}>{task.subtasks.map((s) => <li key={s.id}><button className="task-title" onClick={() => onOpen(s.id)}>{s.title}</button> <StatusBadge status={s.status} /></li>)}</ul>}
        {p.update && <AddInline label={t("ui.new_subtask")} onAdd={(title) => act(() => api(`/api/orgs/${orgId}/tasks`, { method: "POST", body: { projectId: task.projectId, parentId: task.id, title } }))} />}
      </section>

      {/* dependencies */}
      <section className="card" aria-labelledby="h-dep">
        <h2 id="h-dep">{t("ui.dependencies")}</h2>
        <h3>{t("ui.prerequisites")}</h3>
        {task.prerequisites.length === 0 ? <p className="muted small">—</p> : (
          <ul style={{ paddingLeft: "1.1rem", margin: 0 }}>
            {task.prerequisites.map((x) => (
              <li key={x.id}>
                {x.restricted ? <span className="muted">🔒 {t("error.forbidden")}</span> : <><button className="task-title" onClick={() => onOpen(x.id)}>{x.title}</button> <StatusBadge status={x.status} /></>}
                {p.manageDependencies && <Btn small kind="ghost" aria-label={t("ui.remove")} onClick={() => void act(() => api(`/api/orgs/${orgId}/tasks/${task.id}/dependencies`, { method: "DELETE", body: { prerequisiteId: x.id } }))}>✕</Btn>}
              </li>
            ))}
          </ul>
        )}
        {p.manageDependencies && <DependencyPicker orgId={orgId} excludeId={task.id} onPick={(id) => void act(() => api(`/api/orgs/${orgId}/tasks/${task.id}/dependencies`, { method: "POST", body: { prerequisiteId: id } }))} />}
        {task.dependents.length > 0 && <><h3>{t("ui.dependents")}</h3><ul style={{ paddingLeft: "1.1rem", margin: 0 }}>{task.dependents.map((x) => <li key={x.id}>{x.restricted ? <span className="muted">🔒</span> : <button className="task-title" onClick={() => onOpen(x.id)}>{x.title}</button>}</li>)}</ul></>}
      </section>

      {/* attachments */}
      <section className="card" aria-labelledby="h-files">
        <h2 id="h-files">{t("ui.attachments")}</h2>
        {files.data?.attachments.length === 0 && <p className="muted small">{t("ui.no_attachments")}</p>}
        <ul style={{ paddingLeft: "1.1rem", margin: 0 }}>
          {files.data?.attachments.map((f) => (
            <li key={f.id}>
              <a href={`/api/orgs/${orgId}/attachments/${f.id}`} download>{f.filename}</a> <span className="muted small">({Math.max(1, Math.round(f.sizeBytes / 1024))} KB)</span>
              {p.attach && <Btn small kind="ghost" aria-label={t("ui.delete")} onClick={async () => { await api(`/api/orgs/${orgId}/attachments/${f.id}`, { method: "DELETE" }).catch((e) => toast(err(e), "error")); files.reload(); }}>✕</Btn>}
            </li>
          ))}
        </ul>
        {p.attach && (
          <div className="field" style={{ marginTop: "0.6rem" }}>
            <label htmlFor="upload">{t("ui.upload")}</label>
            <input id="upload" type="file" onChange={async (e) => {
              const f = e.target.files?.[0]; e.target.value = "";
              if (!f) return;
              const fd = new FormData(); fd.set("file", f);
              const res = await fetch(`/api/orgs/${orgId}/tasks/${task.id}/attachments`, { method: "POST", body: fd, credentials: "same-origin" });
              if (!res.ok) { const j = await res.json().catch(() => null); toast(j?.error?.message ?? t("error.generic"), "error"); } else files.reload();
            }} />
            <span className="hint">{t("ui.max_size", { mb: Math.floor(MAX_UPLOAD_BYTES / 1_000_000) })}</span>
          </div>
        )}
      </section>

      {/* comments */}
      <section className="card" aria-labelledby="h-comments">
        <h2 id="h-comments">{t("ui.comments")}</h2>
        {comments.data?.comments.length === 0 && <Empty />}
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {comments.data?.comments.map((c) => (
            <li key={c.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border)" }}>
              <strong>{c.authorName}</strong> <span className="muted small">{instant(c.createdAt)}</span>
              <div className="pre-wrap">{c.body}</div>
            </li>
          ))}
        </ul>
        {p.comment && <CommentBox people={assigneeOptions} onPost={async (body, mentionUserIds) => { await act(() => api(`/api/orgs/${orgId}/tasks/${task.id}/comments`, { method: "POST", body: { body, mentionUserIds } })); comments.reload(); }} />}
      </section>

      <section className="card" aria-labelledby="h-act">
        <h2 id="h-act">{t("ui.activity")}</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {activity.data?.activity.map((a) => (
            <li key={a.id} className="small" style={{ padding: "0.2rem 0" }}>
              <span className="muted">{instant(a.createdAt)}</span> · {nameOf.get(a.actorId ?? "") ?? ""} {activityLabel(a.type, t)}
              {a.type === "status_changed" && !!a.changes.status && <> ({t(`status.${(a.changes.status as { from: string }).from}` as never)} → {t(`status.${(a.changes.status as { to: string }).to}` as never)})</>}
            </li>
          ))}
        </ul>
      </section>

      <div className="row between">
        <span className="muted small">{task.startDate && `${t("ui.start")}: ${date(task.startDate)}`} {task.dueDate && `· ${t("ui.due")}: ${date(task.dueDate)}`}</span>
        {p.delete && <Btn kind="danger" onClick={async () => { if (!window.confirm(t("ui.confirm_delete"))) return; await api(`/api/orgs/${orgId}/tasks/${task.id}`, { method: "DELETE" }).then(() => { onClose(); reload(); window.dispatchEvent(new CustomEvent("task-deleted", { detail: task.id })); }).catch((e) => toast(err(e), "error")); }}>{t("ui.delete_task")}</Btn>}
      </div>
      <span hidden>{locale}</span>
    </div>
  );
}

const activityLabel = (type: string, t: (k: never) => string) => ((`ui.activity_${type}`) in allMessages.en ? t((`ui.activity_${type}`) as never) : type);

function AssigneeEditor({ task, people, canAssignOthers, onSave }: { task: Detail; people: Person[]; canAssignOthers: boolean; onSave: (primary: string | null, co: string[]) => void }) {
  const { t } = useI18n();
  const { user } = useOrg();
  const [primary, setPrimary] = useState(task.primaryAssigneeId ?? "");
  const [co, setCo] = useState<string[]>(task.coAssigneeIds);
  const choices = canAssignOthers ? people : people.filter((x) => x.id === user.id);
  return (
    <div className="stack">
      <Field label={t("ui.assignee")}>{(id) => (
        <select id={id} value={primary} onChange={(e) => setPrimary(e.target.value)}>
          <option value="">{t("ui.unassigned")}</option>
          {task.primaryAssigneeId && !choices.some((c) => c.id === task.primaryAssigneeId) && <option value={task.primaryAssigneeId}>…</option>}
          {choices.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
      )}</Field>
      {canAssignOthers && (
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">{t("ui.co_assignees")}</legend>
          <div className="row">
            {people.filter((x) => x.id !== primary).map((x) => <label key={x.id} className="row" style={{ gap: "0.3rem" }}><input type="checkbox" checked={co.includes(x.id)} onChange={(e) => setCo(e.target.checked ? [...co, x.id] : co.filter((c) => c !== x.id))} />{x.name}</label>)}
          </div>
        </fieldset>
      )}
      <Btn small kind="primary" onClick={() => onSave(primary || null, canAssignOthers ? co.filter((c) => c !== primary) : [])}>{t("ui.save")}</Btn>
    </div>
  );
}

function CustomFields({ defs, values, editable, onSave }: { defs: FieldDef[]; values: Record<string, unknown>; editable: boolean; onSave: (v: Record<string, unknown>) => void }) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const val = (d: FieldDef) => (d.id in draft ? draft[d.id] : values[d.id] ?? (d.type === "checkbox" ? false : ""));
  return (
    <section className="card" aria-labelledby="h-cf">
      <h2 id="h-cf">{t("ui.custom_fields")}</h2>
      <div className="grid cols-2">
        {defs.map((d) => (
          <Field key={d.id} label={d.name}>{(id) => {
            const v = val(d);
            const set = (x: unknown) => setDraft({ ...draft, [d.id]: x === "" ? null : x });
            if (d.type === "checkbox") return <input id={id} type="checkbox" checked={v === true} disabled={!editable} onChange={(e) => set(e.target.checked)} />;
            if (d.type === "dropdown") return <select id={id} value={String(v ?? "")} disabled={!editable} onChange={(e) => set(e.target.value)}><option value="" />{d.options.filter((o) => !o.archived || o.id === v).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>;
            return <input id={id} type={d.type === "number" ? "number" : d.type === "date" ? "date" : "text"} value={String(v ?? "")} disabled={!editable} min={d.minValue ?? undefined} max={d.maxValue ?? undefined} onChange={(e) => set(d.type === "number" && e.target.value !== "" ? Number(e.target.value) : e.target.value)} />;
          }}</Field>
        ))}
      </div>
      {editable && Object.keys(draft).length > 0 && <Btn small kind="primary" onClick={() => { onSave(draft); setDraft({}); }}>{t("ui.save")}</Btn>}
    </section>
  );
}

function AddInline({ label, onAdd }: { label: string; onAdd: (title: string) => Promise<unknown> }) {
  const [title, setTitle] = useState("");
  return (
    <form className="row" style={{ marginTop: "0.5rem" }} onSubmit={async (e) => { e.preventDefault(); if (!title.trim()) return; await onAdd(title.trim()); setTitle(""); }}>
      <label className="sr-only" htmlFor={`add-${label}`}>{label}</label>
      <input id={`add-${label}`} value={title} placeholder={label} onChange={(e) => setTitle(e.target.value)} maxLength={300} style={{ flex: 1 }} />
      <Btn type="submit" small>+</Btn>
    </form>
  );
}

function DependencyPicker({ orgId, excludeId, onPick }: { orgId: string; excludeId: string; onPick: (id: string) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<{ id: string; title: string }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return;
    const timer = setTimeout(() => { void api<{ items: { id: string; title: string }[] }>(`/api/orgs/${orgId}/tasks?q=${encodeURIComponent(q.trim())}&limit=8`).then((r) => setResults(r.items.filter((i) => i.id !== excludeId))).catch(() => setResults([])); }, 250);
    return () => clearTimeout(timer);
  }, [q, orgId, excludeId]);
  return (
    <div className="stack" style={{ marginTop: "0.5rem" }}>
      <label className="sr-only" htmlFor="dep-q">{t("ui.add_dependency")}</label>
      <input id="dep-q" value={q} placeholder={t("ui.pick_task")} onChange={(e) => setQ(e.target.value)} />
      {q.trim().length >= 2 && results.length > 0 && <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>{results.map((r) => <li key={r.id}>{r.title} <Btn small onClick={() => { onPick(r.id); setQ(""); setResults([]); }}>{t("ui.add")}</Btn></li>)}</ul>}
    </div>
  );
}

function CommentBox({ people, onPost }: { people: Person[]; onPost: (body: string, mentions: string[]) => Promise<void> }) {
  const { t } = useI18n();
  const [body, setBody] = useState("");
  const [mentions, setMentions] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  return (
    <form style={{ marginTop: "0.75rem" }} onSubmit={async (e) => { e.preventDefault(); if (!body.trim()) return; setBusy(true); await onPost(body.trim(), mentions); setBody(""); setMentions([]); setBusy(false); }}>
      <label className="sr-only" htmlFor="comment">{t("ui.comments")}</label>
      <textarea id="comment" value={body} placeholder={t("ui.comment_placeholder")} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
      <div className="row between">
        <label className="row"><span className="sr-only">{t("ui.mention")}</span>
          <select value="" onChange={(e) => { const x = people.find((pp) => pp.id === e.target.value); if (x) { setBody((b) => `${b}${b && !b.endsWith(" ") ? " " : ""}@${x.name} `); setMentions((m) => [...new Set([...m, x.id])]); } }}>
            <option value="">@ {t("ui.mention")}</option>{people.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <Btn type="submit" kind="primary" disabled={busy || !body.trim()}>{t("ui.post")}</Btn>
      </div>
    </form>
  );
}
