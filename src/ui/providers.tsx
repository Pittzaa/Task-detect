"use client";
import type { ReactNode } from "react";
import type { Locale } from "@/i18n";
import { ToastProvider } from "./components";
import { I18nProvider, useI18n } from "./i18n";

function SkipLink() {
  const { t } = useI18n();
  return <a className="skip-link" href="#main">{t("ui.skip")}</a>;
}

export function Providers({ children, initialLocale, appName }: { children: ReactNode; initialLocale: Locale; appName: string }) {
  return (
    <I18nProvider initialLocale={initialLocale} appName={appName}>
      <ToastProvider>
        <SkipLink />
        {children}
      </ToastProvider>
    </I18nProvider>
  );
}
