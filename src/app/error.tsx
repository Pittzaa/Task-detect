"use client";
import Link from "next/link";
import { useI18n } from "@/ui/i18n";

/** Boundary for every page below the root layout. Server-side details never reach the browser; `digest` ties this screen to the server log. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useI18n();
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : "";
  return (
    <main id="main" className="auth">
      <div className="card" role="alert">
        <h1>{t("ui.error_title")}</h1>
        <p>{t("ui.error_body")}</p>
        {digest && <p className="muted small">{t("ui.error_reference", { ref: digest })}</p>}
        <div className="row">
          <button className="btn primary" onClick={() => retry()}>{t("ui.retry")}</button>
          <Link className="btn" href="/">{t("ui.back_home")}</Link>
        </div>
      </div>
    </main>
  );
}
