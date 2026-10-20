import { cookies } from "next/headers";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { DEFAULT_APP_NAME } from "@/domain/app-name";
import { installationBrand } from "@/server/brand";
import { getRuntime } from "@/server/runtime";
import { Providers } from "@/ui/providers";
import "./globals.css";

// the page title carries the name the administrators gave the product (src/server/brand.ts)
export async function generateMetadata(): Promise<Metadata> {
  const name = await installationBrand(getRuntime().db).catch(() => DEFAULT_APP_NAME);
  return { title: { default: name, template: `%s · ${name}` }, robots: { index: false, follow: false } };
}
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = (await cookies()).get("tt_locale")?.value === "en" ? "en" : "th";
  const appName = await installationBrand(getRuntime().db).catch(() => DEFAULT_APP_NAME); // a failed read must not take the whole site down
  return (
    <html lang={locale}>
      <body>
        <Providers initialLocale={locale} appName={appName}>{children}</Providers>
      </body>
    </html>
  );
}
