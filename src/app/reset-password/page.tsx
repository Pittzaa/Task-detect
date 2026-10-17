"use client";
import Link from "next/link";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authApi } from "@/ui/api";
import { AuthLayout } from "@/ui/auth-layout";
import { Btn, Field, Notice } from "@/ui/components";
import { useI18n } from "@/ui/i18n";

function Form() {
  const { t } = useI18n();
  const router = useRouter();
  const token = useSearchParams().get("token");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError(false);
    try { await authApi("/reset-password", { newPassword: password, token }); router.replace("/login?verified=1"); }
    catch { setError(true); }
    finally { setBusy(false); }
  }
  if (!token) return <AuthLayout title={t("ui.reset_password")}><Notice kind="error">{t("ui.invalid_token")}</Notice><p><Link href="/forgot-password">{t("ui.send_reset")}</Link></p></AuthLayout>;
  return (
    <AuthLayout title={t("ui.reset_password")}>
      <form onSubmit={submit}>
        {error && <Notice kind="error">{t("ui.invalid_token")}</Notice>}
        <Field label={t("ui.new_password")} hint={t("ui.password_hint")}>{(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Btn type="submit" kind="primary" disabled={busy}>{t("ui.save")}</Btn>
      </form>
    </AuthLayout>
  );
}
export default function ResetPasswordPage() { return <Suspense><Form /></Suspense>; }
