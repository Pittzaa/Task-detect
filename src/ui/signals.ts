"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { api } from "./api";

export interface SignalTokens { tasks?: string; notifications?: string; comments?: string }

interface Env {
  visible(): boolean;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  random(): number;
}

interface Channel {
  listeners: Set<() => void>;
  tokens: SignalTokens;
  timer?: unknown;
  failures: number;
  inFlight: boolean;
  polledAt?: number;
}

/**
 * One cheap "has anything changed?" request per address, shared by every component that asks for it, only while the tab is visible.
 * Backs off after errors, stops when the last subscriber leaves, and polls immediately when the tab becomes visible again.
 * The page then re-fetches its real data only when a token differs from the one before. (This is still polling, not push: changes
 * show up within roughly one interval, see docs/ARCHITECTURE.md.)
 */
export class SignalHub {
  private channels = new Map<string, Channel>();
  /** Last tokens of a channel whose last subscriber just left, so a quick leave-and-return (navigation, remount) does not trigger a request. */
  private recent = new Map<string, { tokens: SignalTokens; at: number }>();
  constructor(private fetchTokens: (url: string) => Promise<SignalTokens>, private env: Env & { now?(): number }, private intervalMs = 8000, private maxBackoffMs = 60_000) {}

  private now() { return this.env.now ? this.env.now() : Date.now(); }

  /** Stable per-address snapshot for useSyncExternalStore (replaced only when a token actually changes). */
  snapshot(url: string): SignalTokens { return this.channels.get(url)?.tokens ?? this.recent.get(url)?.tokens ?? EMPTY; }

  subscribe(url: string, listener: () => void): () => void {
    let ch = this.channels.get(url);
    let fresh = false;
    if (!ch) {
      const r = this.recent.get(url);
      fresh = !!r && this.now() - r.at < this.intervalMs;
      ch = { listeners: new Set(), tokens: r?.tokens ?? EMPTY, failures: 0, inFlight: false };
      this.channels.set(url, ch);
    }
    ch.listeners.add(listener);
    if (ch.listeners.size === 1) { if (fresh) this.schedule(url, ch); else void this.poll(url); }
    return () => {
      const c = this.channels.get(url);
      if (!c) return;
      c.listeners.delete(listener);
      if (c.listeners.size === 0) {
        if (c.timer !== undefined) this.env.clearTimeout(c.timer);
        this.channels.delete(url);
        this.recent.set(url, { tokens: c.tokens, at: c.polledAt ?? this.now() });
      }
    };
  }

  /** Poll now (tab became visible / window focused). */
  kick() { for (const url of this.channels.keys()) void this.poll(url); }

  private schedule(url: string, ch: Channel) {
    if (ch.timer !== undefined) this.env.clearTimeout(ch.timer);
    const base = ch.failures ? Math.min(this.maxBackoffMs, this.intervalMs * 2 ** ch.failures) : this.intervalMs;
    ch.timer = this.env.setTimeout(() => void this.poll(url), base * (1 + this.env.random() * 0.25));
  }

  private async poll(url: string) {
    const ch = this.channels.get(url);
    if (!ch || ch.inFlight) return;
    if (!this.env.visible()) { this.schedule(url, ch); return; } // hidden tab: keep the timer, skip the request
    ch.inFlight = true;
    try {
      const next = await this.fetchTokens(url);
      const live = this.channels.get(url);
      if (live !== ch) return; // everyone left while the request was in flight
      ch.failures = 0;
      ch.polledAt = this.now();
      if (next.tasks !== ch.tokens.tasks || next.notifications !== ch.tokens.notifications || next.comments !== ch.tokens.comments) {
        ch.tokens = next;
        for (const l of ch.listeners) l();
      }
    } catch {
      ch.failures = Math.min(ch.failures + 1, 6);
    } finally {
      ch.inFlight = false;
      if (this.channels.get(url) === ch) this.schedule(url, ch);
    }
  }
}

const EMPTY: SignalTokens = Object.freeze({});

let hub: SignalHub | undefined;
function theHub(): SignalHub {
  hub ??= new SignalHub(
    (url) => api<SignalTokens>(url),
    { visible: () => document.visibilityState === "visible", now: () => Date.now(), setTimeout: (fn, ms) => window.setTimeout(fn, ms), clearTimeout: (id) => window.clearTimeout(id as number), random: Math.random },
  );
  return hub;
}

/**
 * The latest change tokens for an organization (and, optionally, one task's comments). Components pass a token to `useQuery({ signal })`
 * so their data is re-fetched only when it changed.
 */
export function useChangeSignal(orgId: string, taskId?: string): SignalTokens {
  const url = `/api/orgs/${orgId}/changes${taskId ? `?task=${taskId}` : ""}`;
  const h = theHub();
  useEffect(() => {
    const kick = () => h.kick();
    window.addEventListener("focus", kick);
    document.addEventListener("visibilitychange", kick);
    return () => { window.removeEventListener("focus", kick); document.removeEventListener("visibilitychange", kick); };
  }, [h]);
  // The functions must be stable between renders: React re-subscribes whenever `subscribe` changes, which here would restart polling on every render.
  const subscribe = useCallback((cb: () => void) => h.subscribe(url, cb), [h, url]);
  const snapshot = useCallback(() => h.snapshot(url), [h, url]);
  return useSyncExternalStore(subscribe, snapshot, () => EMPTY);
}
