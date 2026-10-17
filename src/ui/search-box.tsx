"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useI18n } from "./i18n";

export function SearchBox({ base }: { base: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [q, setQ] = useState("");
  return (
    <form role="search" onSubmit={(e) => { e.preventDefault(); if (q.trim().length >= 2) router.push(`${base}/search?q=${encodeURIComponent(q.trim())}`); }} style={{ flex: "0 1 420px" }}>
      <label className="sr-only" htmlFor="global-search">{t("ui.search")}</label>
      <input id="global-search" type="search" placeholder={t("ui.search_placeholder")} value={q} onChange={(e) => setQ(e.target.value)} style={{ width: "100%" }} />
    </form>
  );
}
