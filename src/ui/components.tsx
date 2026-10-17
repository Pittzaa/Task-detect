"use client";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { TaskPriority, TaskStatus } from "@/domain/workflow";
import { useI18n } from "./i18n";

export function Spinner({ label }: { label?: string }) {
  return <span role="status" aria-live="polite"><span className="spinner" aria-hidden="true" /> <span className="sr-only">{label ?? "…"}</span></span>;
}

export function Loading() {
  const { t } = useI18n();
  return <p className="muted"><Spinner label={t("ui.loading")} /> {t("ui.loading")}</p>;
}

export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useI18n();
  return <p className="muted" style={{ padding: "1rem 0" }}>{children ?? t("ui.empty")}</p>;
}

export function ErrorNote({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { err, t } = useI18n();
  return (
    <div className="notice error" role="alert">
      {err(error)} {onRetry && <button className="btn small" onClick={onRetry}>{t("ui.retry")}</button>}
    </div>
  );
}

export function Notice({ kind = "info", children }: { kind?: "info" | "error" | "success" | "warn"; children: ReactNode }) {
  return <div className={`notice ${kind === "info" ? "" : kind}`} role={kind === "error" ? "alert" : "status"}>{children}</div>;
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: (id: string, describedBy: string | undefined) => ReactNode }) {
  const id = useId();
  const desc = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id, desc)}
      {hint && !error && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="err" id={`${id}-err`} role="alert">{error}</span>}
    </div>
  );
}

export function Btn({ kind, small, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: "primary" | "danger" | "ghost"; small?: boolean }) {
  return <button type="button" {...p} className={`btn ${kind ?? ""} ${small ? "small" : ""} ${p.className ?? ""}`} />;
}

const STATUS_GLYPH: Record<TaskStatus, string> = { todo: "○", progress: "◐", review: "◉", done: "✓", cancelled: "✕", blocked: "■" };
const PRIORITY_GLYPH: Record<TaskPriority, string> = { urgent: "▲▲", high: "▲", medium: "●", low: "▽" };

export function StatusBadge({ status }: { status: TaskStatus }) {
  const { t } = useI18n();
  return <span className="badge" data-s={status}><span aria-hidden="true">{STATUS_GLYPH[status]}</span>{t(`status.${status}` as never)}</span>;
}
export function PriorityBadge({ priority }: { priority: TaskPriority }) {
  const { t } = useI18n();
  return <span className="badge" data-p={priority}><span aria-hidden="true">{PRIORITY_GLYPH[priority]}</span>{t(`priority.${priority}` as never)}</span>;
}

// ---- dialogs ---------------------------------------------------------------------------------

function useDialogBehaviour(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () => node?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])') ?? [];
    (focusables()[0] ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
      if (e.key === "Tab") {
        const f = [...focusables()];
        if (!f.length) return;
        const first = f[0]!, last = f[f.length - 1]!;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [open, onClose]);
  return ref;
}

export function Modal({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useDialogBehaviour(open, onClose);
  const tid = useId();
  if (!open) return null;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby={tid} ref={ref} tabIndex={-1}>
        <div className="row between"><h2 id={tid}>{title}</h2><Btn small kind="ghost" onClick={onClose} aria-label="Close">✕</Btn></div>
        {children}
      </div>
    </>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useDialogBehaviour(open, onClose);
  const tid = useId();
  if (!open) return null;
  return (
    <>
      <div className="drawer-scrim" onClick={onClose} aria-hidden="true" />
      <div className="drawer" role="dialog" aria-modal="true" aria-labelledby={tid} ref={ref} tabIndex={-1}>
        <div className="row between"><h2 id={tid} className="truncate" style={{ maxWidth: "80%" }}>{title}</h2><Btn small kind="ghost" onClick={onClose} aria-label="Close">✕</Btn></div>
        {children}
      </div>
    </>
  );
}

export function Tabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: { id: T; label: string }[]; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button key={tab.id} role="tab" aria-selected={value === tab.id} onClick={() => onChange(tab.id)} id={`tab-${tab.id}`}>{tab.label}</button>
      ))}
    </div>
  );
}

// ---- toasts ----------------------------------------------------------------------------------

interface Toast { id: number; text: string; kind: "ok" | "error" }
const ToastCtx = createContext<(text: string, kind?: "ok" | "error") => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, text, kind }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" aria-live="polite" aria-atomic="false">
        {items.map((i) => <div key={i.id} className={`toast ${i.kind === "error" ? "error" : ""}`} role={i.kind === "error" ? "alert" : "status"}>{i.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);
