"use client";
import Link from "next/link";
import { useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import { api, authApi } from "@/ui/api";
import { AuthLayout } from "@/ui/auth-layout";
import { Btn, ErrorNote, Loading, Notice } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";

interface Membership { membershipId: string; status: "pending" | "approved" | "suspended" | "revoked"; org: { id: string; name: string; slug: string } | null }

export default function Home() {
  const { t, applyLocale, setTimezone } = useI18n();
  const router = useRouter();
  const me = useQuery("me", () => api<{ locale: "th" | "en"; timezone: string }>("/api/me"));
  const mem = useQuery(me.data ? "memberships" : null, () => api<{ memberships: Membership[] }>("/api/me/memberships"));

  useEffect(() => { if (me.error?.status === 401) router.replace("/login"); }, [me.error, router]);
  const profileLocale = me.data?.locale;
  useEffect(() => { if (profileLocale) applyLocale(profileLocale); }, [profileLocale, applyLocale]);
  const profileZone = me.data?.timezone;
  useEffect(() => { if (profileZone) setTimezone(profileZone); }, [profileZone, setTimezone]);
  const approved = useMemo(() => mem.data?.memberships.filter((m) => m.status === "approved" && m.org) ?? [], [mem.data]);
  useEffect(() => { if (approved.length === 1) router.replace(`/o/${approved[0]!.org!.id}/my-tasks`); }, [approved, router]);

  async function signOut() { await authApi("/sign-out", {}).catch(() => undefined); router.replace("/login"); }

  if (me.loading || (me.data && mem.loading)) return <AuthLayout title={t("app.name")}><Loading /></AuthLayout>;
  if (me.error && me.error.status !== 401) return <AuthLayout title={t("app.name")}><ErrorNote error={me.error} onRetry={me.reload} /></AuthLayout>;
  if (!me.data) return null;
  const pending = mem.data?.memberships.filter((m) => m.status === "pending") ?? [];
  const blocked = mem.data?.memberships.filter((m) => m.status === "suspended" || m.status === "revoked") ?? [];

  return (
    <AuthLayout title={t("ui.your_orgs")}>
      {mem.error && <ErrorNote error={mem.error} onRetry={mem.reload} />}
      {approved.length > 0 && (
        <ul style={{ paddingLeft: "1.1rem" }}>
          {approved.map((m) => <li key={m.membershipId}><Link href={`/o/${m.org!.id}/my-tasks`}>{m.org!.name}</Link></li>)}
        </ul>
      )}
      {approved.length === 0 && pending.length === 0 && <p className="muted">{t("ui.no_orgs")}</p>}
      {pending.length > 0 && <Notice kind="warn"><strong>{t("ui.pending_title")}</strong><br />{t("ui.pending_body")}</Notice>}
      {blocked.length > 0 && <p className="muted small">{blocked.map((b) => t(`ui.status_label_${b.status}` as never)).join(", ")}</p>}
      <div className="row" style={{ marginTop: "1rem" }}>
        <Link className="btn" href="/join">{t("ui.join_org")}</Link>
        <Link className="btn" href="/security">{t("ui.security")}</Link>
        <Btn onClick={() => void signOut()}>{t("ui.signout")}</Btn>
      </div>
    </AuthLayout>
  );
}
