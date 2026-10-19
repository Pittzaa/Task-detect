"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { api, authApi, ApiError } from "@/ui/api";
import { AuthLayout } from "@/ui/auth-layout";
import { Btn, Field, Notice } from "@/ui/components";
import { useI18n } from "@/ui/i18n";

function LoginForm() {
  const { t, err } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needsCode, setNeedsCode] = useState(false);
  const [useBackup, setUseBackup] = useState(false);
  // `error` comes back from a redirect (Better Auth appends it); only its kind is used, the text itself is never shown
  const redirected = params.get("error");
  const [message, setMessage] = useState<{ kind: "error" | "success" | "warn"; text: string } | undefined>(() => (
    params.get("verified") ? { kind: "success", text: t("ui.password_changed") }
    : params.get("erased") ? { kind: "success", text: t("ui.erased_ok") }
    : redirected ? { kind: "error", text: /registration_closed/i.test(redirected) ? t("error.registration_closed") : t("ui.signin_failed_redirect") }
    : undefined));
  const [busy, setBusy] = useState(false);
  const [needsVerify, setNeedsVerify] = useState(false);
  const [google, setGoogle] = useState(false);

  useEffect(() => { void api<{ google?: boolean }>("/api/auth-config").then((c) => setGoogle(!!c.google)).catch(() => undefined); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setMessage(undefined); setNeedsVerify(false);
    try {
      if (needsCode) {
        await authApi(useBackup ? "/two-factor/verify-backup-code" : "/two-factor/verify-totp", { code: code.trim() });
      } else {
        const res = await authApi<{ twoFactorRedirect?: boolean }>("/sign-in/email", { email, password });
        if (res.twoFactorRedirect) { setNeedsCode(true); setBusy(false); return; }
      }
      router.replace(safeNext(params.get("next")));
    } catch (e2) {
      if (e2 instanceof ApiError && e2.status === 403) { setMessage({ kind: "warn", text: t("ui.verify_needed") }); setNeedsVerify(true); }
      else setMessage({ kind: "error", text: e2 instanceof ApiError && e2.status === 401 ? t("error.unauthenticated") : err(e2) });
    } finally { setBusy(false); }
  }

  // one e-mail per address every 10 minutes (the server enforces it); the answer never says whether the address has an account
  async function resendVerification() {
    if (!email.trim()) return;
    setBusy(true);
    try {
      await authApi("/send-verification-email", { email: email.trim(), callbackURL: "/login?verified=1" });
      setMessage({ kind: "success", text: t("ui.verify_resent") });
      setNeedsVerify(false);
    } catch (e3) {
      setMessage(e3 instanceof ApiError && e3.status === 429 ? { kind: "warn", text: t("ui.verify_limited") } : { kind: "error", text: err(e3) });
    } finally { setBusy(false); }
  }

  async function withGoogle() {
    const res = await authApi<{ url?: string }>("/sign-in/social", { provider: "google", callbackURL: safeNext(params.get("next")), errorCallbackURL: "/login" });
    if (res.url) window.location.href = res.url;
  }

  return (
    <AuthLayout title={t("ui.signin")} footer={<>{t("ui.no_account")} <Link href="/register">{t("ui.register")}</Link></>}>
      <form onSubmit={submit} noValidate>
        {message && <Notice kind={message.kind}>{message.text}</Notice>}
        {needsVerify && <p><Btn type="button" onClick={() => void resendVerification()} disabled={busy}>{t("ui.verify_resend")}</Btn></p>}
        {!needsCode ? (
          <>
            <Field label={t("ui.email")}>{(id) => <input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
            <Field label={t("ui.password")}>{(id) => <input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
          </>
        ) : (
          <>
            <Field label={useBackup ? t("ui.backup_code") : t("ui.two_factor_code")}>{(id) => <input id={id} inputMode={useBackup ? "text" : "numeric"} autoComplete="one-time-code" autoCapitalize="none" autoCorrect="off" required value={code} onChange={(e) => setCode(e.target.value)} />}</Field>
            <p><button type="button" className="linklike" onClick={() => { setUseBackup(!useBackup); setCode(""); setMessage(undefined); }}>{useBackup ? t("ui.use_authenticator") : t("ui.use_backup_code")}</button></p>
          </>
        )}
        <div className="row between">
          <Btn type="submit" kind="primary" disabled={busy}>{t("ui.signin")}</Btn>
          <Link href="/forgot-password" className="small">{t("ui.forgot_password")}</Link>
        </div>
      </form>
      {google && <p><Btn onClick={() => void withGoogle()}>{t("ui.sign_in_google")}</Btn></p>}
    </AuthLayout>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
