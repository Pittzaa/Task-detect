"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { allMessages, t as translate, type Locale, type MessageKey } from "@/i18n";
import { formatDate as fmtDate, formatInstant as fmtInstant } from "@/domain/time";
import { ApiError, api } from "./api";

interface Ctx {
  locale: Locale;
  timezone: string;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
  /** The person chose a language: switches the page and stores it on their profile. */
  setLocale: (l: Locale) => Promise<void>;
  /** Adopt the language the profile already has (no write: syncing from the server must never write back, or it can overwrite a newer choice). */
  applyLocale: (l: Locale) => void;
  /** Applies the signed-in user's profile time zone (used for "today", overdue and times). Display only; nothing is persisted. */
  setTimezone: (tz: string) => void;
  date: (d: string) => string;
  instant: (d: Date | string) => string;
  /** Localized message for an API error (stable codes map to dictionary keys). */
  err: (e: unknown) => string;
}

const I18n = createContext<Ctx | null>(null);

export function I18nProvider({ children, initialLocale = "th", timezone: initialTimezone = "Asia/Bangkok" }: { children: ReactNode; initialLocale?: Locale; timezone?: string }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const [timezone, setTimezoneState] = useState(initialTimezone);
  const setTimezone = useCallback((tz: string) => {
    try { new Intl.DateTimeFormat("en", { timeZone: tz }); setTimezoneState(tz); } catch { /* unknown zone: keep the current one */ }
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.cookie = `tt_locale=${locale}; path=/; max-age=31536000; samesite=lax`;
  }, [locale]);

  const t = useCallback((key: MessageKey, vars?: Record<string, string | number>) => translate(locale, key, vars), [locale]);
  const setLocale = useCallback(async (l: Locale) => {
    setLocaleState(l);
    try { await api("/api/me", { method: "PATCH", body: { locale: l } }); } catch { /* signed-out pages just switch locally */ }
  }, []);
  const applyLocale = useCallback((l: Locale) => setLocaleState(l), []);
  const err = useCallback((e: unknown) => {
    if (e instanceof ApiError) {
      if (e.message.startsWith("val.") && e.message in allMessages[locale]) {
        return translate(locale, e.message as MessageKey, { from: String(e.data?.from ?? ""), to: String(e.data?.to ?? "") });
      }
      const map: Record<string, MessageKey> = { NOT_FOUND: "error.not_found", FORBIDDEN: "error.forbidden", UNAUTHENTICATED: "error.unauthenticated", RATE_LIMITED: "error.rate_limited", VALIDATION: "error.validation", CONFLICT: "error.conflict", REGISTRATION_CLOSED: "error.registration_closed" };
      if (e.code === "VALIDATION" && e.message && !e.message.startsWith("val.") && e.message !== "Invalid input") return e.message;
      if (e.code === "CONFLICT" && e.message) return e.message;
      return map[e.code] ? translate(locale, map[e.code]!) : translate(locale, "error.generic");
    }
    return translate(locale, "error.generic");
  }, [locale]);

  const value = useMemo<Ctx>(() => ({ locale, timezone, t, setLocale, applyLocale, setTimezone, err, date: (d) => fmtDate(d, locale), instant: (d) => fmtInstant(typeof d === "string" ? new Date(d) : d, locale, timezone) }), [locale, timezone, t, setLocale, applyLocale, setTimezone, err]);
  return <I18n.Provider value={value}>{children}</I18n.Provider>;
}

export function useI18n(): Ctx {
  const v = useContext(I18n);
  if (!v) throw new Error("useI18n must be used inside I18nProvider");
  return v;
}
