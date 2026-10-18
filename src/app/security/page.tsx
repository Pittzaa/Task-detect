"use client";
import Link from "next/link";
import QRCode from "qrcode";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, authApi } from "@/ui/api";
import { Btn, ErrorNote, Field, Loading, Notice, TableWrap, useToast } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";

interface SessionRow { token: string; id: string; userAgent?: string | null; ipAddress?: string | null; createdAt: string }
interface SessionInfo { session: { token: string }; user: { twoFactorEnabled?: boolean | null } }

export default function SecurityPage() {
  const { t, err, locale, setTimezone } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const me = useQuery("me", () => api<{ name: string; email: string; locale: "th" | "en"; timezone: string }>("/api/me"));
  const info = useQuery("session", () => authApi<SessionInfo | null>("/get-session"));
  const sessions = useQuery("sessions", () => authApi<SessionRow[]>("/list-sessions"));
  useEffect(() => { if (me.error?.status === 401) router.replace("/login?next=/security"); }, [me.error, router]);
  const profileZone = me.data?.timezone;
  useEffect(() => { if (profileZone) setTimezone(profileZone); }, [profileZone, setTimezone]);

  // two-factor enrolment
  const [password, setPassword] = useState("");
  const [enrol, setEnrol] = useState<{ uri: string; qr: string; codes: string[] }>();
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string }>();

  async function startEnrol(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    try {
      const r = await authApi<{ totpURI: string; backupCodes: string[] }>("/two-factor/enable", { password });
      setEnrol({ uri: r.totpURI, codes: r.backupCodes, qr: await QRCode.toDataURL(r.totpURI, { margin: 1, width: 200 }) });
      setPassword("");
    } catch (e2) { setMsg({ kind: "error", text: err(e2) }); }
  }
  async function confirmEnrol(e: React.FormEvent) {
    e.preventDefault();
    try { await authApi("/two-factor/verify-totp", { code: code.trim() }); setEnrol(undefined); setCode(""); info.reload(); toast(t("ui.two_factor_enable")); }
    catch (e2) { setMsg({ kind: "error", text: err(e2) }); }
  }
  async function disable2fa(e: React.FormEvent) {
    e.preventDefault();
    try { await authApi("/two-factor/disable", { password }); setPassword(""); info.reload(); }
    catch (e2) { setMsg({ kind: "error", text: err(e2) }); }
  }
  async function revoke(token: string) { await authApi("/revoke-session", { token }).catch((e2) => toast(err(e2), "error")); sessions.reload(); }
  async function revokeOthers() { await authApi("/revoke-other-sessions", {}).catch((e2) => toast(err(e2), "error")); sessions.reload(); }
  async function signOut() { await authApi("/sign-out", {}).catch(() => undefined); router.replace("/login"); }

  if (me.loading) return <main id="main" className="main"><Loading /></main>;
  if (me.error) return <main id="main" className="main"><ErrorNote error={me.error} onRetry={me.reload} /></main>;
  const enabled = !!info.data?.user.twoFactorEnabled;
  const current = info.data?.session.token;

  return (
    <main id="main" className="main stack" style={{ maxWidth: 820 }}>
      <p className="row between"><Link href="/">← {t("ui.back")}</Link><Btn onClick={() => void signOut()}>{t("ui.signout")}</Btn></p>
      <h1>{t("ui.security")}</h1>

      <section className="card" aria-labelledby="h-profile">
        <h2 id="h-profile">{t("ui.profile")}</h2>
        <ProfileForm key={`${me.data!.name}|${me.data!.timezone}`} initialName={me.data!.name} initialTz={me.data!.timezone} onSaved={me.reload} />
      </section>

      <section className="card" aria-labelledby="h-pw">
        <h2 id="h-pw">{t("ui.change_password")}</h2>
        <PasswordForm />
      </section>

      <section className="card" aria-labelledby="h-2fa">
        <h2 id="h-2fa">{t("ui.two_factor")}</h2>
        {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
        {enrol ? (
          <form onSubmit={confirmEnrol}>
            <p>{t("ui.two_factor_scan")}</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={enrol.qr} alt="QR" width={200} height={200} />
            <p className="small muted" style={{ overflowWrap: "anywhere" }}>{enrol.uri}</p>
            <p className="label">{t("ui.backup_codes")}</p>
            <pre className="card" style={{ margin: 0 }}>{enrol.codes.join("\n")}</pre>
            <Field label={t("ui.two_factor_code")}>{(id) => <input id={id} inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <Btn type="submit" kind="primary">{t("ui.confirm")}</Btn>
          </form>
        ) : (
          <form onSubmit={enabled ? disable2fa : startEnrol}>
            <Field label={t("ui.confirm_password")}>{(id) => <input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
            <Btn type="submit" kind={enabled ? "danger" : "primary"}>{enabled ? t("ui.two_factor_disable") : t("ui.two_factor_enable")}</Btn>
          </form>
        )}
      </section>

      <section className="card" aria-labelledby="h-sessions">
        <div className="row between"><h2 id="h-sessions">{t("ui.sessions")}</h2><Btn small onClick={() => void revokeOthers()}>{t("ui.revoke_others")}</Btn></div>
        {sessions.error ? <ErrorNote error={sessions.error} onRetry={sessions.reload} /> : (
          <TableWrap label={t("ui.sessions")}><table>
            <tbody>
              {(sessions.data ?? []).map((s) => (
                <tr key={s.id}>
                  <td className="truncate" style={{ maxWidth: 320 }}>{s.userAgent ?? "—"}<br /><span className="muted small">{s.ipAddress ?? ""} · {new Date(s.createdAt).toLocaleString(locale === "th" ? "th-TH" : "en-GB")}</span></td>
                  <td style={{ textAlign: "right" }}>{s.token === current ? <span className="badge" data-s="done">{t("ui.current_session")}</span> : <Btn small onClick={() => void revoke(s.token)}>{t("ui.revoke")}</Btn>}</td>
                </tr>
              ))}
            </tbody>
          </table></TableWrap>
        )}
      </section>

      <section className="card" aria-labelledby="h-data">
        <h2 id="h-data">{t("ui.your_data")}</h2>
        <p className="muted">{t("ui.your_data_help")}</p>
        <a className="btn" href="/api/me/export" download>{t("ui.download_data")}</a>
      </section>

      <section className="card" aria-labelledby="h-erase">
        <h2 id="h-erase">{t("ui.erase_account")}</h2>
        <p className="muted">{t("ui.erase_help")}</p>
        <EraseForm email={me.data?.email ?? ""} />
      </section>
    </main>
  );
}

function ProfileForm({ initialName, initialTz, onSaved }: { initialName: string; initialTz: string; onSaved: () => void }) {
  const { t, err, locale, setLocale } = useI18n();
  const toast = useToast();
  const [name, setName] = useState(initialName);
  const [tz, setTz] = useState(initialTz);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try { await api("/api/me", { method: "PATCH", body: { name, timezone: tz, locale } }); toast(t("ui.save")); onSaved(); }
    catch (e2) { toast(err(e2), "error"); }
  }
  return (
    <form onSubmit={save}>
      <div className="grid cols-2">
        <Field label={t("ui.name")}>{(id) => <input id={id} required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t("ui.timezone")}>{(id) => <input id={id} required list="tzlist" value={tz} onChange={(e) => setTz(e.target.value)} />}</Field>
        <Field label={t("ui.language")}>{(id) => (
          <select id={id} value={locale} onChange={(e) => void setLocale(e.target.value as "th" | "en")}><option value="th">ไทย</option><option value="en">English</option></select>
        )}</Field>
      </div>
      <datalist id="tzlist">{(typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : ["Asia/Bangkok", "UTC"]).map((z) => <option key={z} value={z} />)}</datalist>
      <Btn type="submit" kind="primary">{t("ui.save")}</Btn>
    </form>
  );
}

function PasswordForm() {
  const { t, err } = useI18n();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [others, setOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "error" | "success"; text: string }>();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    if (next !== again) { setMsg({ kind: "error", text: t("ui.password_mismatch") }); return; }
    setBusy(true);
    try {
      await authApi("/change-password", { currentPassword: current, newPassword: next, revokeOtherSessions: others });
      setCurrent(""); setNext(""); setAgain("");
      setMsg({ kind: "success", text: t("ui.password_changed_ok") }); toast(t("ui.password_changed_ok"));
    } catch (e2) {
      setMsg({ kind: "error", text: e2 instanceof ApiError && (e2.status === 400 || e2.status === 401) && !/PASSWORD_(TOO|LENGTH)/.test(e2.code) ? t("ui.wrong_password") : err(e2) });
    } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit}>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      <Field label={t("ui.current_password")}>{(id) => <input id={id} type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />}</Field>
      <Field label={t("ui.new_password")} hint={t("ui.password_hint")}>{(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={next} onChange={(e) => setNext(e.target.value)} />}</Field>
      <Field label={t("ui.confirm_new_password")}>{(id) => <input id={id} type="password" autoComplete="new-password" required minLength={12} maxLength={128} value={again} onChange={(e) => setAgain(e.target.value)} />}</Field>
      <label className="row" style={{ gap: "0.4rem", marginBottom: "0.85rem" }}><input type="checkbox" checked={others} onChange={(e) => setOthers(e.target.checked)} />{t("ui.sign_out_others")}</label>
      <Btn type="submit" kind="primary" disabled={busy}>{t("ui.change_password")}</Btn>
    </form>
  );
}

function EraseForm({ email }: { email: string }) {
  const { t, err } = useI18n();
  const router = useRouter();
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [abandon, setAbandon] = useState(false);
  const [needsAbandon, setNeedsAbandon] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setMsg(undefined);
    if (!window.confirm(t("ui.erase_confirm_dialog"))) return;
    setBusy(true);
    try {
      await api("/api/me", { method: "DELETE", body: { confirmEmail: typed, ...(password ? { password } : {}), ...(abandon ? { abandonOrganizations: true } : {}) } });
      router.replace("/login?erased=1");
    } catch (e2) {
      if (e2 instanceof ApiError && e2.data?.needsAbandon) setNeedsAbandon(true);
      setMsg(e2 instanceof ApiError && e2.status === 422 && /password/i.test(e2.message) ? t("ui.wrong_password") : e2 instanceof ApiError && e2.status === 422 && /e-mail/i.test(e2.message) ? t("ui.erase_mismatch") : err(e2));
    } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit}>
      {msg && <Notice kind="error">{msg}</Notice>}
      <Field label={t("ui.erase_confirm_email", { email })}>{(id) => <input id={id} type="email" autoComplete="off" required value={typed} onChange={(e) => setTyped(e.target.value)} />}</Field>
      <Field label={t("ui.current_password")} hint={t("ui.erase_password_hint")}>{(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
      {needsAbandon && <label className="row" style={{ gap: "0.4rem", marginBottom: "0.85rem" }}><input type="checkbox" checked={abandon} onChange={(e) => setAbandon(e.target.checked)} />{t("ui.erase_abandon")}</label>}
      <Btn type="submit" kind="danger" disabled={busy || !typed}>{t("ui.erase_account")}</Btn>
    </form>
  );
}
