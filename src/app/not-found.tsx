"use client";
import Link from "next/link";
import { useI18n } from "@/ui/i18n";

export default function NotFoundPage() {
  const { t } = useI18n();
  return (
    <main id="main" className="auth">
      <div className="card">
        <h1>{t("ui.not_found_title")}</h1>
        <p>{t("ui.not_found_body")}</p>
        <Link className="btn primary" href="/">{t("ui.back_home")}</Link>
      </div>
    </main>
  );
}
