"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { DISCORD_EVENTS, NOTIFICATION_TYPES } from "@/domain/notifications";
import { api } from "@/ui/api";
import { Btn, Empty, ErrorNote, Field, Loading, Notice, TableWrap, Tabs, useToast } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";

type TabId = "notifications" | "integrations" | "fields" | "labels";

function Settings() {
  const { can } = useOrg();
  const { t } = useI18n();
  const initial = useSearchParams().get("calendar") ? "integrations" : "notifications";
  const [tab, setTab] = useState<TabId>(initial);
  const tabs: { id: TabId; label: string }[] = [
    { id: "notifications", label: t("ui.notification_settings") },
    { id: "integrations", label: t("ui.integrations") },
    ...(can.manageCustomFields ? [{ id: "fields" as const, label: t("ui.fields_admin") }] : []),
    ...(can.manageLabels ? [{ id: "labels" as const, label: t("ui.labels") }] : []),
  ];
  return (
    <div className="stack">
      <h1>{t("ui.settings")}</h1>
      <Tabs<TabId> label={t("ui.settings")} value={tab} onChange={setTab} tabs={tabs} />
      {tab === "notifications" && <NotificationSettings />}
      {tab === "integrations" && <Integrations />}
      {tab === "fields" && <CustomFieldsAdmin />}
      {tab === "labels" && <LabelsAdmin />}
    </div>
  );
}
export default function Page() { return <Suspense><Settings /></Suspense>; }

// ---------------------------------------------------------------------------------------------
interface SettingsView { settings: { channel: "in_app" | "email"; event: string; enabled: boolean; isDefault: boolean }[]; digest: "off" | "daily" | "weekly"; quietStart: string | null; quietEnd: string | null }

function NotificationSettings() {
  const { orgId } = useOrg();
  const { t, err } = useI18n();
  const toast = useToast();
  const q = useQuery<SettingsView>(`ns:${orgId}`, () => api(`/api/orgs/${orgId}/notification-settings`));
  async function put(body: unknown) { try { await api(`/api/orgs/${orgId}/notification-settings`, { method: "PUT", body }); q.reload(); toast(t("ui.save")); } catch (e) { toast(err(e), "error"); } }
  if (q.loading && !q.data) return <Loading />;
  if (q.error) return <ErrorNote error={q.error} onRetry={q.reload} />;
  const s = q.data!;
  return (
    <div className="stack">
      <TableWrap label={t("ui.notification_settings")}><table>
        <thead><tr><th>{t("ui.events")}</th><th>{t("ui.channel_in_app")}</th><th>{t("ui.channel_email")}</th></tr></thead>
        <tbody>
          {NOTIFICATION_TYPES.map((ev) => (
            <tr key={ev}>
              <td>{t(`notify.${ev === "task.assigned" ? "assigned" : ev === "task.unassigned" ? "unassigned" : ev === "task.commented" ? "comment" : ev === "task.mentioned" ? "mention" : ev === "task.status_changed" ? "status" : ev === "task.priority_changed" ? "priority" : ev === "task.due_soon" ? "due_soon" : ev === "task.overdue" ? "overdue" : "dependency"}` as never, { actor: "…", task: "…", status: "…", priority: "…", date: "…" })}</td>
              {(["in_app", "email"] as const).map((ch) => {
                const row = s.settings.find((x) => x.channel === ch && x.event === ev)!;
                return <td key={ch}><input type="checkbox" aria-label={`${ev} ${ch}`} checked={row.enabled} onChange={(e) => void put({ settings: [{ channel: ch, event: ev, enabled: e.target.checked }] })} /></td>;
              })}
            </tr>
          ))}
        </tbody>
      </table></TableWrap>
      <div className="card grid cols-3">
        <Field label={t("ui.digest")}>{(id) => (
          <select id={id} value={s.digest} onChange={(e) => void put({ digest: e.target.value })}><option value="off">{t("ui.digest_off")}</option><option value="daily">{t("ui.digest_daily")}</option><option value="weekly">{t("ui.digest_weekly")}</option></select>
        )}</Field>
        <Field label={`${t("ui.quiet_hours")}: ${t("ui.quiet_start")}`}>{(id) => <input id={id} type="time" value={s.quietStart ?? ""} onChange={(e) => void put(e.target.value ? { quietStart: e.target.value, quietEnd: s.quietEnd ?? "07:00" } : { quietStart: null, quietEnd: null })} />}</Field>
        <Field label={t("ui.quiet_end")}>{(id) => <input id={id} type="time" value={s.quietEnd ?? ""} disabled={!s.quietStart} onChange={(e) => void put({ quietEnd: e.target.value })} />}</Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
interface Dest { id: string; name: string; teamId: string | null; projectId: string | null; events: string[]; includeDetails: boolean; enabled: boolean; disabledReason: string | null; webhook: string; lastStatus: string | null; lastDeliveryAt: string | null }
interface Cal { connected: boolean; configured?: boolean; status?: string; lastSyncAt?: string | null; lastError?: string | null; linkedEvents?: number; failingEvents?: number }

function Integrations() {
  const { orgId, can } = useOrg();
  const { t, err, instant } = useI18n();
  const toast = useToast();
  const cal = useQuery<Cal>(`cal:${orgId}`, () => api(`/api/orgs/${orgId}/calendar`), { refreshMs: 60_000 });
  const dests = useQuery<{ destinations: Dest[] }>(can.manageIntegrations ? `dests:${orgId}` : null, () => api(`/api/orgs/${orgId}/integrations/discord`));
  const health = useQuery<{ kinds: { kind: string; pending: number; dead: number; lastError: string | null }[] }>(can.manageIntegrations ? `health:${orgId}` : null, () => api(`/api/orgs/${orgId}/integrations/health`), { refreshMs: 60_000 });
  const projects = useQuery<{ projects: { id: string; name: string }[] }>(can.manageIntegrations ? `projects:${orgId}` : null, () => api(`/api/orgs/${orgId}/projects`));
  const teams = useQuery<{ teams: { id: string; name: string }[] }>(can.manageIntegrations ? `teams:${orgId}` : null, () => api(`/api/orgs/${orgId}/teams`));
  const [form, setForm] = useState({ name: "", url: "", target: "", events: ["task.assigned", "task.status_changed"] as string[], details: false });
  const [deleteEvents, setDeleteEvents] = useState(false);

  async function connectCal() { try { const r = await api<{ url: string }>(`/api/orgs/${orgId}/calendar/connect`, { method: "POST" }); window.location.href = r.url; } catch (e) { toast(err(e), "error"); } }
  async function addDest(e: React.FormEvent) {
    e.preventDefault();
    const [kind, id] = form.target.split(":");
    try {
      await api(`/api/orgs/${orgId}/integrations/discord`, { method: "POST", body: { name: form.name, webhookUrl: form.url, [kind === "team" ? "teamId" : "projectId"]: id, events: form.events, includeDetails: form.details } });
      setForm({ ...form, name: "", url: "" }); dests.reload();
    } catch (e2) { toast(err(e2), "error"); }
  }

  return (
    <div className="stack">
      <section className="card" aria-labelledby="h-cal">
        <h2 id="h-cal">{t("ui.calendar_sync")}</h2>
        <p className="muted">{t("ui.calendar_oneway")}</p>
        {cal.loading && !cal.data && <Loading />}
        {cal.data && cal.data.configured === false && <Notice kind="warn">{t("ui.calendar_not_configured")}</Notice>}
        {cal.data?.connected ? (
          <div className="stack">
            <p>{t("ui.calendar_status")}: <span className="badge" data-s={cal.data.status === "active" ? "done" : "blocked"}>{cal.data.status}</span> · {t("ui.last_sync")}: {cal.data.lastSyncAt ? instant(cal.data.lastSyncAt) : "—"} · {cal.data.linkedEvents} / {cal.data.failingEvents} ✕{cal.data.lastError ? ` · ${cal.data.lastError}` : ""}</p>
            <div className="row">
              <Btn small onClick={async () => { try { await api(`/api/orgs/${orgId}/calendar/resync`, { method: "POST" }); toast(t("ui.calendar_resync")); } catch (e) { toast(err(e), "error"); } }}>{t("ui.calendar_resync")}</Btn>
              {cal.data.status !== "active" && cal.data.configured && <Btn small kind="primary" onClick={() => void connectCal()}>{t("ui.calendar_connect")}</Btn>}
              <label className="row small" style={{ gap: "0.3rem" }}><input type="checkbox" checked={deleteEvents} onChange={(e) => setDeleteEvents(e.target.checked)} />{t("ui.calendar_delete_events")}</label>
              <Btn small kind="danger" onClick={async () => { try { await api(`/api/orgs/${orgId}/calendar?deleteEvents=${deleteEvents}`, { method: "DELETE" }); cal.reload(); } catch (e) { toast(err(e), "error"); } }}>{t("ui.calendar_disconnect")}</Btn>
            </div>
          </div>
        ) : cal.data?.configured && <Btn kind="primary" onClick={() => void connectCal()}>{t("ui.calendar_connect")}</Btn>}
      </section>

      {can.manageIntegrations && (
        <section className="card" aria-labelledby="h-discord">
          <h2 id="h-discord">{t("ui.discord")}</h2>
          {dests.data?.destinations.length === 0 && <Empty />}
          {dests.data?.destinations.map((d) => (
            <div key={d.id} className="row between" style={{ padding: "0.5rem 0", borderTop: "1px solid var(--border)" }}>
              <span><strong>{d.name}</strong> <code>{d.webhook}</code><br /><span className="small muted">{d.events.join(", ")}{d.includeDetails ? " · ⚠ titles" : ""}{!d.enabled ? ` · ${t("ui.disabled_reason", { reason: d.disabledReason ?? "" })}` : ""}</span></span>
              <span className="row">
                <Btn small onClick={async () => { await api(`/api/orgs/${orgId}/integrations/discord/${d.id}`, { method: "PATCH", body: { enabled: !d.enabled } }).catch((e) => toast(err(e), "error")); dests.reload(); }}>{d.enabled ? t("ui.disable") : t("ui.enable")}</Btn>
                <RotateButton orgId={orgId} id={d.id} onDone={dests.reload} />
                <Btn small kind="danger" onClick={async () => { await api(`/api/orgs/${orgId}/integrations/discord/${d.id}`, { method: "DELETE" }).catch((e) => toast(err(e), "error")); dests.reload(); }}>{t("ui.delete")}</Btn>
              </span>
            </div>
          ))}
          <form onSubmit={addDest} style={{ marginTop: "1rem" }}>
            <div className="grid cols-2">
              <Field label={t("ui.name")}>{(id) => <input id={id} required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
              <Field label={t("ui.target")}>{(id) => (
                <select id={id} required value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })}>
                  <option value="" />
                  <optgroup label={t("ui.projects")}>{projects.data?.projects.map((p) => <option key={p.id} value={`project:${p.id}`}>{p.name}</option>)}</optgroup>
                  <optgroup label={t("ui.teams")}>{teams.data?.teams.map((x) => <option key={x.id} value={`team:${x.id}`}>{x.name}</option>)}</optgroup>
                </select>
              )}</Field>
            </div>
            <Field label={t("ui.webhook_url")} hint={t("ui.webhook_hint")}>{(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="off" required value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} style={{ width: "100%" }} />}</Field>
            <fieldset style={{ border: 0, padding: 0 }}><legend className="label">{t("ui.events")}</legend>
              <div className="row">{DISCORD_EVENTS.map((ev) => <label key={ev} className="row small" style={{ gap: "0.3rem" }}><input type="checkbox" checked={form.events.includes(ev)} onChange={(e) => setForm({ ...form, events: e.target.checked ? [...form.events, ev] : form.events.filter((x) => x !== ev) })} />{ev}</label>)}</div>
            </fieldset>
            <label className="row" style={{ gap: "0.4rem", margin: "0.6rem 0" }}><input type="checkbox" checked={form.details} onChange={(e) => setForm({ ...form, details: e.target.checked })} />{t("ui.include_details")}</label>
            {form.details && <Notice kind="warn">{t("ui.include_details_warn")}</Notice>}
            <Btn type="submit" kind="primary">{t("ui.create")}</Btn>
          </form>
        </section>
      )}

      {can.manageIntegrations && (
        <section className="card" aria-labelledby="h-health">
          <h2 id="h-health">{t("ui.job_health")}</h2>
          {health.data?.kinds.length === 0 ? <p className="muted">✓</p> : (
            <table><tbody>{health.data?.kinds.map((k) => <tr key={k.kind}><td><code>{k.kind}</code></td><td>⏳ {k.pending}</td><td className={k.dead ? "overdue" : ""}>✕ {k.dead}</td><td className="muted small">{k.lastError ?? ""}</td></tr>)}</tbody></table>
          )}
        </section>
      )}
    </div>
  );
}

function RotateButton({ orgId, id, onDone }: { orgId: string; id: string; onDone: () => void }) {
  const { t, err } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  if (!open) return <Btn small onClick={() => setOpen(true)}>{t("ui.rotate")}</Btn>;
  return (
    <form className="row" onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/orgs/${orgId}/integrations/discord/${id}/rotate`, { method: "POST", body: { webhookUrl: url } }); setOpen(false); setUrl(""); onDone(); } catch (e2) { toast(err(e2), "error"); } }}>
      <input aria-label={t("ui.webhook_url")} type="password" autoComplete="off" required value={url} onChange={(e) => setUrl(e.target.value)} />
      <Btn small kind="primary" type="submit">{t("ui.save")}</Btn><Btn small onClick={() => setOpen(false)}>{t("ui.cancel")}</Btn>
    </form>
  );
}

// ---------------------------------------------------------------------------------------------
interface FieldDef { id: string; name: string; type: string; options: { id: string; label: string; archived?: boolean }[] }

function CustomFieldsAdmin() {
  const { orgId } = useOrg();
  const { t, err } = useI18n();
  const toast = useToast();
  const q = useQuery<{ fields: FieldDef[] }>(`cf:${orgId}`, () => api(`/api/orgs/${orgId}/custom-fields`));
  const [f, setF] = useState({ name: "", type: "text", options: "", min: "", max: "", def: "" });
  async function create(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { name: f.name, type: f.type };
    if (f.type === "dropdown") body.options = f.options.split("\n").map((x) => x.trim()).filter(Boolean).map((label) => ({ label }));
    if (f.type === "number") { if (f.min !== "") body.minValue = Number(f.min); if (f.max !== "") body.maxValue = Number(f.max); }
    if (f.def !== "" && f.type !== "dropdown") body.defaultValue = f.type === "number" ? Number(f.def) : f.type === "checkbox" ? f.def === "true" : f.def;
    try { await api(`/api/orgs/${orgId}/custom-fields`, { method: "POST", body }); setF({ name: "", type: "text", options: "", min: "", max: "", def: "" }); q.reload(); } catch (e2) { toast(err(e2), "error"); }
  }
  return (
    <div className="stack">
      {q.data?.fields.length === 0 && <Empty />}
      <TableWrap label={t("ui.custom_fields")}><table><tbody>
        {q.data?.fields.map((d) => (
          <tr key={d.id}><td><strong>{d.name}</strong></td><td>{t(`ui.type_${d.type}` as never)}</td><td className="small muted">{d.options.filter((o) => !o.archived).map((o) => o.label).join(", ")}</td>
            <td><Btn small kind="danger" onClick={async () => { await api(`/api/orgs/${orgId}/custom-fields/${d.id}`, { method: "DELETE" }).catch((e) => toast(err(e), "error")); q.reload(); }}>{t("ui.archive")}</Btn></td></tr>
        ))}
      </tbody></table></TableWrap>
      <form className="card" onSubmit={create}>
        <h2>{t("ui.new_field")}</h2>
        <div className="grid cols-2">
          <Field label={t("ui.name")}>{(id) => <input id={id} required maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />}</Field>
          <Field label={t("ui.field_type")}>{(id) => <select id={id} value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{["text", "number", "date", "dropdown", "checkbox"].map((x) => <option key={x} value={x}>{t(`ui.type_${x}` as never)}</option>)}</select>}</Field>
        </div>
        {f.type === "dropdown" && <Field label={t("ui.options")}>{(id) => <textarea id={id} required value={f.options} onChange={(e) => setF({ ...f, options: e.target.value })} />}</Field>}
        {f.type === "number" && <div className="grid cols-2"><Field label={t("ui.min")}>{(id) => <input id={id} type="number" value={f.min} onChange={(e) => setF({ ...f, min: e.target.value })} />}</Field><Field label={t("ui.max")}>{(id) => <input id={id} type="number" value={f.max} onChange={(e) => setF({ ...f, max: e.target.value })} />}</Field></div>}
        {f.type !== "dropdown" && <Field label={t("ui.default_value")}>{(id) => f.type === "checkbox" ? <select id={id} value={f.def} onChange={(e) => setF({ ...f, def: e.target.value })}><option value="" /><option value="true">{t("ui.yes")}</option><option value="false">{t("ui.no")}</option></select> : <input id={id} type={f.type === "number" ? "number" : f.type === "date" ? "date" : "text"} value={f.def} onChange={(e) => setF({ ...f, def: e.target.value })} />}</Field>}
        <Btn type="submit" kind="primary">{t("ui.create")}</Btn>
      </form>
    </div>
  );
}

function LabelsAdmin() {
  const { orgId } = useOrg();
  const { t, err } = useI18n();
  const toast = useToast();
  const q = useQuery<{ labels: { id: string; name: string; color: string }[] }>(`labels:${orgId}`, () => api(`/api/orgs/${orgId}/labels`));
  const [name, setName] = useState("");
  const [color, setColor] = useState("#4338ca");
  return (
    <div className="stack">
      <div className="row">{q.data?.labels.map((l) => <span key={l.id} className="badge" style={{ color: l.color }}>{l.name}</span>)}</div>
      {q.data?.labels.length === 0 && <Empty />}
      <form className="card row" style={{ alignItems: "flex-end" }} onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/orgs/${orgId}/labels`, { method: "POST", body: { name, color } }); setName(""); q.reload(); } catch (e2) { toast(err(e2), "error"); } }}>
        <Field label={t("ui.name")}>{(id) => <input id={id} required maxLength={50} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label="Color">{(id) => <input id={id} type="color" value={color} onChange={(e) => setColor(e.target.value)} />}</Field>
        <div className="field"><Btn type="submit" kind="primary">{t("ui.create")}</Btn></div>
      </form>
    </div>
  );
}
