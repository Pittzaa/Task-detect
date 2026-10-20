"use client";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, authApi } from "@/ui/api";
import { Btn, ErrorNote, Loading } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { OrgContext, type OrgCtx } from "@/ui/org";
import { NotificationBell } from "@/ui/notification-bell";
import { SearchBox } from "@/ui/search-box";

export default function OrgLayout({ children }: { children: ReactNode }) {
  const { orgId } = useParams<{ orgId: string }>();
  const router = useRouter();
  const pathname = usePathname();
  const { t, locale, setLocale, applyLocale, setTimezone, setAppName } = useI18n();
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname; // opening is tied to the current page, so navigating closes the menu
  const setOpen = (v: boolean) => setOpenedOn(v ? pathname : null);
  const ctx = useQuery(`ctx:${orgId}`, () => api<Omit<OrgCtx, "orgId">>(`/api/orgs/${orgId}/context`), { refreshMs: 5 * 60_000 });

  useEffect(() => { if (ctx.error?.status === 401) router.replace(`/login?next=${encodeURIComponent(pathname)}`); }, [ctx.error, router, pathname]);
  const profileLocale = ctx.data?.user.locale;
  useEffect(() => { if (profileLocale) applyLocale(profileLocale); }, [profileLocale, applyLocale]);
  const orgAppName = ctx.data?.org.appName;
  useEffect(() => { if (orgAppName) setAppName(orgAppName); }, [orgAppName, setAppName]);
  const profileZone = ctx.data?.user.timezone;
  useEffect(() => { if (profileZone) setTimezone(profileZone); }, [profileZone, setTimezone]);

  if (ctx.loading && !ctx.data) return <main id="main" className="main"><Loading /></main>;
  if (ctx.error?.status === 401) return null;
  if (ctx.error || !ctx.data) {
    return (
      <main id="main" className="main">
        <ErrorNote error={ctx.error} onRetry={ctx.reload} />
        <p><Link href="/">{t("ui.back")}</Link></p>
      </main>
    );
  }
  const value: OrgCtx = { ...ctx.data, orgId };
  const base = `/o/${orgId}`;
  const link = (href: string, label: string) => (
    <Link key={href} href={`${base}${href}`} aria-current={pathname.startsWith(`${base}${href}`) ? "page" : undefined}>{label}</Link>
  );
  const can = ctx.data.can;

  return (
    <OrgContext.Provider value={value}>
      <div className="shell">
        <nav className="sidebar nav" data-open={open} aria-label={t("app.name")}>
          <div className="brand">{ctx.data.org.name}</div>
          {link("/my-tasks", t("ui.my_tasks"))}
          {link("/tasks", t("ui.tasks"))}
          {link("/dashboard", t("ui.dashboard"))}
          {can.manageSeries && link("/recurring", t("ui.recurring_tasks"))}
          {(can.manageMembers || can.approveMembers || can.manageRoles) && <>{<div className="group">{t("ui.settings")}</div>}{link("/members", t("ui.members"))}</>}
          {(can.manageDepartments || can.manageTeams || can.createProject) && link("/structure", t("ui.structure"))}
          {link("/settings", t("ui.settings"))}
          {can.readAuditLog && link("/audit", t("ui.audit_log"))}
          <div style={{ flex: 1 }} />
          <Link href="/" className="small muted" style={{ padding: "0.5rem 0.75rem" }}>{t("ui.your_orgs")}</Link>
          <Link href="/security" className="small muted" style={{ padding: "0.5rem 0.75rem" }}>{t("ui.security")}</Link>
        </nav>
        {open && <div className="scrim" onClick={() => setOpen(false)} aria-hidden="true" />}
        <div style={{ minWidth: 0 }}>
          <header className="topbar">
            <Btn className="menu-btn" small onClick={() => setOpen(!open)} aria-label={t("ui.toggle_menu")} aria-expanded={open}><svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 6h16M4 12h16M4 18h16" /></svg></Btn>
            <SearchBox base={base} />
            <span className="spacer" />
            <NotificationBell orgId={orgId} />
            <Btn small onClick={() => void setLocale(locale === "th" ? "en" : "th")} aria-label={`${locale === "th" ? "EN" : "ไทย"} (${t("ui.language")})`}>{locale === "th" ? "EN" : "ไทย"}</Btn>
            <Btn small onClick={async () => { await authApi("/sign-out", {}).catch(() => undefined); router.replace("/login"); }}>{t("ui.signout")}</Btn>
          </header>
          <main id="main" className="main" tabIndex={-1}>{children}</main>
        </div>
      </div>
    </OrgContext.Provider>
  );
}
