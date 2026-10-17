"use client";
import { useState } from "react";
import { api } from "@/ui/api";
import { Btn, Empty, ErrorNote, Loading } from "@/ui/components";
import { useQuery } from "@/ui/hooks";
import { useI18n } from "@/ui/i18n";
import { useOrg } from "@/ui/org";

interface Row { id: string; action: string; actorName: string | null; targetType: string | null; metadata: Record<string, unknown>; createdAt: string }

export default function AuditPage() {
  const { orgId } = useOrg();
  const { t, instant } = useI18n();
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState("");
  const q = useQuery<{ items: Row[]; hasMore: boolean }>(`audit:${orgId}:${offset}:${action}`, () => api(`/api/orgs/${orgId}/audit-logs?limit=50&offset=${offset}${action ? `&action=${encodeURIComponent(action)}` : ""}`));
  return (
    <div className="stack">
      <h1>{t("ui.audit_log")}</h1>
      <label className="row"><span className="label">{t("ui.action")}</span><input value={action} onChange={(e) => { setAction(e.target.value); setOffset(0); }} placeholder="task. / membership. / auth." /></label>
      {q.loading && !q.data && <Loading />}
      {q.error && <ErrorNote error={q.error} onRetry={q.reload} />}
      {q.data && q.data.items.length === 0 && <Empty />}
      {q.data && q.data.items.length > 0 && (
        <div className="table-wrap"><table>
          <thead><tr><th>{t("ui.when")}</th><th>{t("ui.who")}</th><th>{t("ui.action")}</th><th /></tr></thead>
          <tbody>{q.data.items.map((r) => <tr key={r.id}><td className="small">{instant(r.createdAt)}</td><td>{r.actorName ?? "—"}</td><td><code>{r.action}</code></td><td className="small muted">{Object.keys(r.metadata).length ? JSON.stringify(r.metadata) : ""}</td></tr>)}</tbody>
        </table></div>
      )}
      <div className="row"><Btn disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>{t("ui.previous")}</Btn><Btn disabled={!q.data?.hasMore} onClick={() => setOffset(offset + 50)}>{t("ui.next")}</Btn></div>
    </div>
  );
}
