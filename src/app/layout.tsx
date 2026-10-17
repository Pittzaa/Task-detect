import type { ReactNode } from "react";

export const metadata = { title: "Task Tracker" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="th">
      <body>{children}</body>
    </html>
  );
}
