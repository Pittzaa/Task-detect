"use client";
import Link from "next/link";
import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, ApiError } from "@/ui/api";
import { AuthLayout } from "@/ui/auth-layout";
import { Btn, Notice, Loading } from "@/ui/components";
import { useI18n } from "@/ui/i18n";

function Accept() {
  const { t } = useI18n();
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [signedIn, setSignedIn] = useState<boolean>();
  const [state, setState] = useState<"idle" | "busy" | "ok" | "bad">("idle");

  useEffect(() => { api("/api/me").then(() => setSignedIn(true)).catch((e) => setSignedIn(e instanceof ApiError && e.status === 401 ? false : true)); }, []);
  useEffect(() => { if (signedIn === false) router.replace(`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`); }, [signedIn, router, token]);

  async function accept() {
    setState("busy");
    try { await api("/api/invitations/accept", { method: "POST", body: { token } }); setState("ok"); setTimeout(() => router.replace("/"), 800); }
    catch { setState("bad"); }
  }
  if (signedIn === undefined || signedIn === false) return <AuthLayout title={t("ui.accept_invite")}><Loading /></AuthLayout>;
  return (
    <AuthLayout title={t("ui.accept_invite")} footer={<Link href="/">{t("ui.back")}</Link>}>
      {state === "bad" && <Notice kind="error">{t("ui.invite_invalid")}</Notice>}
      {state === "ok" && <Notice kind="success">{t("ui.invite_accepted")}</Notice>}
      <Btn kind="primary" onClick={() => void accept()} disabled={state === "busy" || state === "ok" || !token}>{t("ui.accept_invite")}</Btn>
    </AuthLayout>
  );
}
export default function InvitePage() { return <Suspense><Accept /></Suspense>; }
