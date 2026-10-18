"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api } from "@/ui/api";
import { AuthLayout } from "@/ui/auth-layout";
import { Btn, Field, Notice } from "@/ui/components";
import { useI18n } from "@/ui/i18n";

export default function JoinPage() {
  const { t, err } = useI18n();
  const [slug, setSlug] = useState("");
  const [state, setState] = useState<{ kind: "error" | "success"; text: string }>();
  const [busy, setBusy] = useState(false);
  const [cfg, setCfg] = useState<{ registrationOpen?: boolean; singleOrganization?: boolean }>({});
  useEffect(() => { void api<typeof cfg>("/api/auth-config").then(setCfg).catch(() => undefined); }, []);
  // With exactly one organization there is nothing to choose, so no code is asked for.
  const single = cfg.singleOrganization === true;
  const closed = single && cfg.registrationOpen === false;
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try { await api("/api/access-requests", { method: "POST", body: single ? {} : { orgSlug: slug } }); setState({ kind: "success", text: t("ui.join_sent") }); }
    catch (e2) { setState({ kind: "error", text: err(e2) }); }
    finally { setBusy(false); }
  }
  return (
    <AuthLayout title={t("ui.join_org")} footer={<Link href="/">{t("ui.back")}</Link>}>
      <p className="muted">{single ? t("ui.join_hint_single") : t("ui.join_hint")}</p>
      {closed && <Notice kind="error">{t("ui.join_closed")}</Notice>}
      {state && <Notice kind={state.kind}>{state.text}</Notice>}
      <form onSubmit={submit}>
        {!single && <Field label={t("ui.org_slug")}>{(id) => <input id={id} required autoCapitalize="none" autoCorrect="off" value={slug} onChange={(e) => setSlug(e.target.value)} />}</Field>}
        <Btn type="submit" kind="primary" disabled={busy || closed} style={closed ? { marginTop: "0.85rem" } : undefined}>{t("ui.join_org")}</Btn>
      </form>
    </AuthLayout>
  );
}
