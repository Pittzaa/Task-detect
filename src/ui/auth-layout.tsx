"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { useI18n } from "./i18n";

export function AuthLayout({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const { t, locale, setLocale } = useI18n();
  return (
    <main id="main" className="auth">
      <p className="row between">
        <Link href="/" style={{ fontWeight: 700, textDecoration: "none" }}>{t("app.name")}</Link>
        <button className="btn small ghost" onClick={() => void setLocale(locale === "th" ? "en" : "th")} aria-label={`${locale === "th" ? "English" : "ไทย"} (${t("ui.language")})`}>{locale === "th" ? "English" : "ไทย"}</button>
      </p>
      <div className="card">
        <h1>{title}</h1>
        {children}
      </div>
      {footer && <p className="muted small" style={{ textAlign: "center" }}>{footer}</p>}
    </main>
  );
}
