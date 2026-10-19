"use client";
import Link from "next/link";
import { useState } from "react";
import { ApiError, authApi } from "@/ui/api";
import { AuthLayout } from "@/ui/auth-layout";
import { Btn, Field, Notice } from "@/ui/components";
import { useI18n } from "@/ui/i18n";

export default function ForgotPasswordPage() {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await authApi("/request-password-reset", { email, redirectTo: "/reset-password" }); }
    catch (e2) { if (e2 instanceof ApiError && e2.status === 429) setLimited(true); /* any other failure: the same message as a success, so nothing tells an unknown address apart */ }
    setSent(true); setBusy(false);
  }
  return (
    <AuthLayout title={t("ui.reset_password")} footer={<Link href="/login">{t("ui.signin")}</Link>}>
      {sent ? (limited ? <Notice kind="warn">{t("ui.forgot_limited")}</Notice> : <Notice kind="success">{t("ui.reset_sent")}</Notice>) : (
        <form onSubmit={submit}>
          <Field label={t("ui.email")}>{(id) => <input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
          <Btn type="submit" kind="primary" disabled={busy}>{t("ui.send_reset")}</Btn>
        </form>
      )}
    </AuthLayout>
  );
}
