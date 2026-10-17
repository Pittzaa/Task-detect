"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "@/ui/api";
import { AuthLayout } from "@/ui/auth-layout";
import { Btn, Field, Notice } from "@/ui/components";
import { useI18n } from "@/ui/i18n";

export default function JoinPage() {
  const { t, err } = useI18n();
  const [slug, setSlug] = useState("");
  const [state, setState] = useState<{ kind: "error" | "success"; text: string }>();
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await api("/api/access-requests", { method: "POST", body: { orgSlug: slug } }); setState({ kind: "success", text: t("ui.join_sent") }); }
    catch (e2) { setState({ kind: "error", text: err(e2) }); }
    finally { setBusy(false); }
  }
  return (
    <AuthLayout title={t("ui.join_org")} footer={<Link href="/">{t("ui.back")}</Link>}>
      <p className="muted">{t("ui.join_hint")}</p>
      {state && <Notice kind={state.kind}>{state.text}</Notice>}
      <form onSubmit={submit}>
        <Field label={t("ui.org_slug")}>{(id) => <input id={id} required autoCapitalize="none" autoCorrect="off" value={slug} onChange={(e) => setSlug(e.target.value)} />}</Field>
        <Btn type="submit" kind="primary" disabled={busy}>{t("ui.join_org")}</Btn>
      </form>
    </AuthLayout>
  );
}
