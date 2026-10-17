"use client";
import Link from "next/link";
import { useState } from "react";
import { authApi } from "@/ui/api";
import { AuthLayout } from "@/ui/auth-layout";
import { Btn, Field, Notice } from "@/ui/components";
import { useI18n } from "@/ui/i18n";

export default function RegisterPage() {
  const { t, locale, err } = useI18n();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, setState] = useState<{ kind: "error" | "success"; text: string }>();
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setState(undefined);
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Bangkok";
      await authApi("/sign-up/email", { name, email, password, locale, timezone, callbackURL: "/login?verified=1" });
      setState({ kind: "success", text: t("ui.check_email") });
    } catch (e2) { setState({ kind: "error", text: err(e2) }); }
    finally { setBusy(false); }
  }

  return (
    <AuthLayout title={t("ui.register")} footer={<>{t("ui.have_account")} <Link href="/login">{t("ui.signin")}</Link></>}>
      <form onSubmit={submit}>
        {state && <Notice kind={state.kind}>{state.text}</Notice>}
        <Field label={t("ui.name")}>{(id) => <input id={id} autoComplete="name" required value={name} onChange={(e) => setName(e.target.value)} />}</Field>
        <Field label={t("ui.email")}>{(id) => <input id={id} type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
        <Field label={t("ui.password")} hint={t("ui.password_hint")}>{(id, d) => <input id={id} aria-describedby={d} type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
        <Btn type="submit" kind="primary" disabled={busy}>{t("ui.register")}</Btn>
      </form>
    </AuthLayout>
  );
}
