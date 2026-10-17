import { en } from "./messages/en";
import { th } from "./messages/th";

export const LOCALES = ["th", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "th";

export type MessageKey = keyof typeof en;
type Vars = Record<string, string | number>;

// `th` is typed against `en`, so a missing or extra key is a compile error.
const dictionaries: Record<Locale, Record<MessageKey, string>> = { en, th };

export const isLocale = (v: unknown): v is Locale => v === "th" || v === "en";

/** Interpolates `{name}` placeholders. Unknown placeholders are left visible rather than silently dropped. */
export function t(locale: Locale, key: MessageKey, vars: Vars = {}): string {
  const template = dictionaries[locale][key] ?? dictionaries[DEFAULT_LOCALE][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (m, name: string) => (name in vars ? String(vars[name]) : m));
}

export const allMessages = dictionaries;
