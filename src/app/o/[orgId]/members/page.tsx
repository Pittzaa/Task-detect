"use client";
import { useState } from "react";
import { PERMISSIONS } from "@/authz/permissions";
import { api } from "@/ui/api";
import { Btn, Empty, ErrorNote, Field, Loading, Notice, TableWrap, Tabs, useToast, useTypedConfirm } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";

interface Member { id: string; status: "pending" | "approved" | "suspended" | "revoked"; userId: string; email: string; name: string; roles: { id: string; roleKey: string; scopeType: string }[] }
interface Role { id: string; key: string; name: string; isSystem: boolean; permissions: string[] }
interface Invite { id: string; email: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }

export default function MembersPage() {
  const { orgId, can } = useOrg();
  const { t, err, date, locale } = useI18n();
  const toast = useToast();
  const confirmDelete = useTypedConfirm();
  const [tab, setTab] = useState<"members" | "invites" | "roles">("members");
  const members = useQuery<{ members: Member[] }>(`members:${orgId}`, () => api(`/api/orgs/${orgId}/members?limit=100`), { refreshMs: 30_000 });
  const roles = useQuery<{ roles: Role[] }>(can.manageRoles || can.approveMembers ? `roles:${orgId}` : null, () => api(`/api/orgs/${orgId}/roles`));
  const invites = useQuery<{ invitations: Invite[] }>(tab === "invites" ? `invites:${orgId}` : null, () => api(`/api/orgs/${orgId}/invitations`), { refreshMs: 30_000 });
  const [pickRole, setPickRole] = useState<Record<string, string>>({});
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("");
  const defaultRole = (key: string) => roles.data?.roles.find((r) => r.isSystem && r.key === key)?.id ?? "";

  async function run(fn: () => Promise<unknown>, ok?: string) {
    try { await fn(); if (ok) toast(ok); members.reload(); invites.reload(); roles.reload(); } catch (e) { toast(err(e), "error"); }
  }

  const pending = members.data?.members.filter((m) => m.status === "pending") ?? [];
  const others = members.data?.members.filter((m) => m.status !== "pending") ?? [];

  return (
    <div className="stack">
      {confirmDelete.dialog}
      <h1>{t("ui.members")}</h1>
      <Tabs label={t("ui.members")} value={tab} onChange={setTab} tabs={[{ id: "members", label: t("ui.members") }, { id: "invites", label: t("ui.invitations") }, { id: "roles", label: t("ui.roles") }]} />
      {tab === "members" && (
        <>
          {members.loading && !members.data && <Loading />}
          {members.error && <ErrorNote error={members.error} onRetry={members.reload} />}
          {pending.length > 0 && (
            <section className="card" aria-labelledby="h-pend">
              <h2 id="h-pend">{t("ui.members_pending")} ({pending.length})</h2>
              {pending.map((m) => (
                <div key={m.id} className="row between" style={{ padding: "0.4rem 0", borderTop: "1px solid var(--border)" }}>
                  <span><strong>{m.name}</strong> <span className="muted">{m.email}</span></span>
                  <span className="row">
                    <select aria-label={t("ui.role")} value={pickRole[m.id] ?? defaultRole("member")} onChange={(e) => setPickRole({ ...pickRole, [m.id]: e.target.value })}>
                      {roles.data?.roles.map((r) => <option key={r.id} value={r.id}>{r.isSystem ? r.key : r.name}</option>)}
                    </select>
                    <Btn kind="primary" small disabled={!can.approveMembers} onClick={() => void run(() => api(`/api/orgs/${orgId}/members/${m.id}/approve`, { method: "POST", body: { roleId: pickRole[m.id] ?? defaultRole("member") } }), t("ui.approve"))}>{t("ui.approve")}</Btn>
                  </span>
                </div>
              ))}
            </section>
          )}
          <TableWrap label={t("ui.members")}>
            <table>
              <thead><tr><th>{t("ui.name")}</th><th>{t("ui.email")}</th><th>{t("ui.status")}</th><th>{t("ui.roles")}</th><th /></tr></thead>
              <tbody>
                {others.map((m) => (
                  <tr key={m.id}>
                    <td>{m.name}</td><td className="muted">{m.email}</td>
                    <td><span className="badge" data-s={m.status === "approved" ? "done" : m.status === "suspended" ? "blocked" : "cancelled"}>{t(`ui.status_label_${m.status}` as never)}</span></td>
                    <td className="small">{m.roles.map((r) => `${r.roleKey}${r.scopeType !== "organization" ? ` (${r.scopeType})` : ""}`).join(", ") || "—"}</td>
                    <td className="row">
                      {m.status === "approved" && <Btn small onClick={() => void run(() => api(`/api/orgs/${orgId}/members/${m.id}/status`, { method: "POST", body: { status: "suspended" } }))}>{t("ui.status_suspend")}</Btn>}
                      {m.status === "suspended" && <Btn small onClick={() => void run(() => api(`/api/orgs/${orgId}/members/${m.id}/status`, { method: "POST", body: { status: "approved" } }))}>{t("ui.status_reactivate")}</Btn>}
                      {m.status !== "revoked" && <Btn small kind="danger" aria-label={`${t("ui.status_revoke")}: ${m.email}`} onClick={() => confirmDelete.ask({ phrase: m.email, body: t("ui.confirm_revoke"), run: async () => { await api(`/api/orgs/${orgId}/members/${m.id}/status`, { method: "POST", body: { status: "revoked" } }); members.reload(); invites.reload(); roles.reload(); } })}>{t("ui.status_revoke")}</Btn>}
                      {can.manageRoles && m.status === "approved" && <AssignRole orgId={orgId} member={m} roles={roles.data?.roles ?? []} onDone={() => members.reload()} />}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableWrap>
        </>
      )}
      {tab === "invites" && (
        <>
          {can.manageMembers && (
            <form className="card row" style={{ alignItems: "flex-end" }} onSubmit={(e) => { e.preventDefault(); void run(async () => {
              const r = await api<{ emailed: boolean }>(`/api/orgs/${orgId}/invitations`, { method: "POST", body: { email: inviteEmail, roleId: inviteRole || defaultRole("member"), locale } });
              toast(r.emailed ? t("ui.invite_sent") : t("ui.invite_not_emailed"), r.emailed ? "ok" : "error"); setInviteEmail("");
            }); }}>
              <Field label={t("ui.invite_email")}>{(id) => <input id={id} type="email" required value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} />}</Field>
              <Field label={t("ui.role")}>{(id) => <select id={id} value={inviteRole || defaultRole("member")} onChange={(e) => setInviteRole(e.target.value)}>{roles.data?.roles.map((r) => <option key={r.id} value={r.id}>{r.isSystem ? r.key : r.name}</option>)}</select>}</Field>
              <div className="field"><Btn type="submit" kind="primary">{t("ui.invite")}</Btn></div>
            </form>
          )}
          {invites.data?.invitations.length === 0 && <Empty />}
          <TableWrap label={t("ui.invitations")}><table><tbody>
            {invites.data?.invitations.map((i) => (
              <tr key={i.id}><td>{i.email}</td><td className="muted">{i.acceptedAt ? t("ui.invite_accepted") : i.revokedAt ? t("ui.status_label_revoked") : date(i.expiresAt.slice(0, 10))}</td>
                <td>{!i.acceptedAt && !i.revokedAt && <Btn small kind="danger" aria-label={`${t("ui.revoke_invite")}: ${i.email}`} onClick={() => confirmDelete.ask({ phrase: i.email, body: t("ui.confirm_revoke_invite"), run: async () => { await api(`/api/orgs/${orgId}/invitations/${i.id}`, { method: "DELETE" }); invites.reload(); } })}>{t("ui.revoke_invite")}</Btn>}</td></tr>
            ))}
          </tbody></table></TableWrap>
        </>
      )}
      {tab === "roles" && <RolesTab orgId={orgId} roles={roles.data?.roles ?? []} canManage={!!can.manageRoles} onChanged={roles.reload} />}
    </div>
  );
}

function AssignRole({ orgId, member, roles, onDone }: { orgId: string; member: Member; roles: Role[]; onDone: () => void }) {
  const { t, err } = useI18n();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [roleId, setRoleId] = useState("");
  const [scope, setScope] = useState<"organization" | "department" | "team" | "project">("organization");
  const [scopeId, setScopeId] = useState("");
  const list = useQuery<Record<string, { id: string; name: string }[]>>(open && scope !== "organization" ? `scope:${orgId}:${scope}` : null, async () => {
    const path = scope === "department" ? "departments" : scope === "team" ? "teams" : "projects";
    const r = await api<Record<string, { id: string; name: string }[]>>(`/api/orgs/${orgId}/${path}`);
    return r;
  });
  if (!open) return <Btn small onClick={() => setOpen(true)}>{t("ui.assign_role")}</Btn>;
  const options = scope === "department" ? list.data?.departments : scope === "team" ? list.data?.teams : list.data?.projects;
  return (
    <form className="row" onSubmit={async (e) => {
      e.preventDefault();
      try { await api(`/api/orgs/${orgId}/assignments`, { method: "POST", body: { membershipId: member.id, roleId, scope: scope === "organization" ? { type: "organization" } : { type: scope, id: scopeId } } }); toast(t("ui.assign_role")); setOpen(false); onDone(); }
      catch (e2) { toast(err(e2), "error"); }
    }}>
      <select aria-label={t("ui.role")} required value={roleId} onChange={(e) => setRoleId(e.target.value)}><option value="" />{roles.map((r) => <option key={r.id} value={r.id}>{r.isSystem ? r.key : r.name}</option>)}</select>
      <select aria-label={t("ui.scope")} value={scope} onChange={(e) => { setScope(e.target.value as typeof scope); setScopeId(""); }}>
        <option value="organization">{t("ui.scope_organization")}</option><option value="department">{t("ui.scope_department")}</option><option value="team">{t("ui.scope_team_s")}</option><option value="project">{t("ui.scope_project")}</option>
      </select>
      {scope !== "organization" && <select aria-label={t("ui.scope")} required value={scopeId} onChange={(e) => setScopeId(e.target.value)}><option value="" />{options?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
      <Btn small kind="primary" type="submit">{t("ui.save")}</Btn><Btn small onClick={() => setOpen(false)}>{t("ui.cancel")}</Btn>
    </form>
  );
}

function RolesTab({ orgId, roles, canManage, onChanged }: { orgId: string; roles: Role[]; canManage: boolean; onChanged: () => void }) {
  const { t, err } = useI18n();
  const toast = useToast();
  const confirmDelete = useTypedConfirm();
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [perms, setPerms] = useState<string[]>([]);
  return (
    <div className="stack">
      {canManage && (
        <form className="card" onSubmit={async (e) => { e.preventDefault(); try { await api(`/api/orgs/${orgId}/roles`, { method: "POST", body: { key, name, permissions: perms } }); setKey(""); setName(""); setPerms([]); onChanged(); } catch (e2) { toast(err(e2), "error"); } }}>
          <h2>{t("ui.new_role")}</h2>
          <div className="grid cols-2">
            <Field label={t("ui.role_key")}>{(id) => <input id={id} required pattern="[a-z][a-z0-9_]{1,40}" value={key} onChange={(e) => setKey(e.target.value)} />}</Field>
            <Field label={t("ui.name")}>{(id) => <input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          </div>
          <fieldset style={{ border: 0, padding: 0 }}><legend className="label">{t("ui.permissions")}</legend>
            <div className="grid cols-3">{PERMISSIONS.map((p) => <label key={p} className="row small" style={{ gap: "0.3rem" }}><input type="checkbox" checked={perms.includes(p)} onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))} />{p}</label>)}</div>
          </fieldset>
          <Btn type="submit" kind="primary">{t("ui.create")}</Btn>
        </form>
      )}
      {roles.map((r) => (
        <section key={r.id} className="card">
          <h3>{r.isSystem ? r.key : r.name} {r.isSystem && <span className="badge" data-p="low">system</span>}</h3>
          <p className="small muted">{r.permissions.join(", ") || "—"}</p>
          {!r.isSystem && canManage && <Btn small kind="danger" aria-label={`${t("ui.delete")}: ${r.name}`} onClick={() => confirmDelete.ask({ phrase: r.name, body: t("ui.confirm_irreversible"), run: async () => { await api(`/api/orgs/${orgId}/roles/${r.id}`, { method: "DELETE" }); onChanged(); } })}>{t("ui.delete")}</Btn>}
        </section>
      ))}
      {confirmDelete.dialog}
      <Notice>{t("ui.permissions")}: {PERMISSIONS.length}</Notice>
    </div>
  );
}
