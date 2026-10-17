import { cookies } from "next/headers";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "@/ui/providers";
import "./globals.css";

export const metadata: Metadata = { title: { default: "Task Tracker", template: "%s · Task Tracker" }, robots: { index: false, follow: false } };
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await cookies()).get("tt_locale")?.value === "en" ? "en" : "th";
  return (
    <html lang={locale}>
      <body>
        <Providers initialLocale={locale}>{children}</Providers>
      </body>
    </html>
  );
}
