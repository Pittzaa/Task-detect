"use client";
import Link from "next/link";
import { useState } from "react";
import { api } from "./api";
import { Btn, Empty, ErrorNote, Loading } from "./components";
import { useQuery } from "./hooks";
import { useChangeSignal } from "./signals";
import { useI18n } from "./i18n";

interface Item { id: string; text: string; taskId: string | null; visible: boolean; read: boolean; createdAt: string }
interface Resp { items: Item[]; unread: number }

/** Polls every 30 s (v1 real-time mechanism). The server renders text per recipient and re-checks access on every read. */
export function NotificationBell({ orgId }: { orgId: string }) {
  const { t, instant } = useI18n();
  const [open, setOpen] = useState(false);
  const sig = useChangeSignal(orgId);
  const q = useQuery<Resp>(`notif:${orgId}`, () => api<Resp>(`/api/orgs/${orgId}/notifications?limit=15`), { signal: sig.notifications, refreshMs: 120_000 });
  async function markAll() { await api(`/api/orgs/${orgId}/notifications`, { method: "POST", body: { all: true } }); q.reload(); }
  const unread = q.data?.unread ?? 0;
  return (
    <div className="bell" style={{ position: "relative" }}>
      <Btn small onClick={() => setOpen(!open)} aria-expanded={open} aria-haspopup="true">
        <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg><span className="sr-only">{t("ui.notifications")}</span>{unread > 0 && <span className="count">{unread > 99 ? "99+" : unread}</span>}
      </Btn>
      {open && (
        <div className="card" role="region" aria-label={t("ui.notifications")} style={{ position: "absolute", right: 0, top: "110%", width: "min(380px, 92vw)", maxHeight: "70vh", overflow: "auto", zIndex: 60 }}>
          <div className="row between"><h2 style={{ margin: 0 }}>{t("ui.notifications")}</h2><Btn small onClick={() => void markAll()} disabled={!unread}>{t("ui.mark_all_read")}</Btn></div>
          {q.loading && !q.data && <Loading />}
          {q.error && <ErrorNote error={q.error} onRetry={q.reload} />}
          {q.data && q.data.items.length === 0 && <Empty>{t("ui.nothing_new")}</Empty>}
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {q.data?.items.map((n) => (
              <li key={n.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--border)", fontWeight: n.read ? 400 : 600 }}>
                {n.taskId && n.visible ? <Link href={`/o/${orgId}/tasks?task=${n.taskId}`} onClick={() => setOpen(false)}>{n.text}</Link> : <span className="muted">{n.text}</span>}
                <div className="muted small">{instant(n.createdAt)}</div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
