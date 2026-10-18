"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface Query<T> { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => void }

interface State<T> { key: string | null; data?: T; error?: ApiError }

/**
 * Minimal data hook: loads when `key` changes, re-fetches on window focus, whenever `signal` changes (a change token from
 * `useChangeSignal`: the cheap way to notice that something happened) and, as a safety net, every `refreshMs`.
 * `loading` is derived (true while the stored result belongs to a different key), stale responses are ignored, and background
 * refreshes never flash a spinner.
 */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>, o: { refreshMs?: number; signal?: string } = {}): Query<T> {
  const [state, setState] = useState<State<T>>({ key: null });
  const seq = useRef(0);
  const fn = useRef(fetcher);
  useEffect(() => { fn.current = fetcher; });

  const load = useCallback(async () => {
    if (key === null) return;
    const mine = ++seq.current;
    try {
      const d = await fn.current();
      if (mine === seq.current) setState({ key, data: d });
    } catch (e) {
      if (mine === seq.current) setState((prev) => ({ key, data: prev.key === key ? prev.data : undefined, error: e instanceof ApiError ? e : new ApiError("INTERNAL", String(e), 0) }));
    }
  }, [key]);

  useEffect(() => { void load(); }, [load]);
  const lastSignal = useRef(o.signal);
  useEffect(() => {
    // the first token only sets the baseline; a later, different one means something changed
    if (o.signal && lastSignal.current && o.signal !== lastSignal.current) void load();
    lastSignal.current = o.signal;
  }, [o.signal, load]);
  useEffect(() => {
    if (key === null) return;
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    const timer = o.refreshMs ? setInterval(() => { if (document.visibilityState === "visible") void load(); }, o.refreshMs) : undefined;
    return () => { window.removeEventListener("focus", onFocus); if (timer) clearInterval(timer); };
  }, [key, load, o.refreshMs]);

  const current = state.key === key;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: key !== null && !(current && (state.data !== undefined || state.error !== undefined)), reload: () => void load() };
}

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}
