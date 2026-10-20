/**
 * The name the product goes by: shown on the sign-in pages, in the page title and the menu, and in every e-mail (subject, header, footer and the
 * sender's display name). The organization's administrators choose it (Settings -> General); until they do it is DEFAULT_APP_NAME.
 *
 * The rules are strict because the name travels into places that parse it: an e-mail header (no line breaks, no quotes or angle brackets, no
 * "@" that would make a display name look like an address) and the HTML of e-mails and pages (escaped everywhere, but a plain name is simplest).
 */
export const DEFAULT_APP_NAME = "Task Tracker";
export const APP_NAME_MAX = 40;

// first character a letter or digit (any script), then letters, digits, combining marks (Thai tone marks are marks) and a few punctuation marks
const ALLOWED = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} .,&'()+:!?_-]*$/u;

export type AppNameResult = { ok: true; value: string | null } | { ok: false };

/** Reads what a person typed. Empty (or null) means "use the default" and comes back as null; anything else is trimmed and must pass the rules. */
export function parseAppName(input: unknown): AppNameResult {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (typeof input !== "string") return { ok: false };
  const value = input.normalize("NFC").replace(/\s+/g, " ").trim(); // one space between words; a line break cannot survive this
  if (value === "") return { ok: true, value: null };
  if ([...value].length > APP_NAME_MAX) return { ok: false };
  if (!ALLOWED.test(value)) return { ok: false };
  return { ok: true, value };
}

/** The name to show for a stored value (null or anything that no longer passes the rules means the default). */
export function appNameOrDefault(stored: string | null | undefined): string {
  const r = parseAppName(stored);
  return r.ok && r.value ? r.value : DEFAULT_APP_NAME;
}

/**
 * The display name to put on an e-mail as its sender: the custom name, or nothing while the default is in use, so that the sender name the
 * operator configured (EMAIL_FROM) stays as it is until an administrator names the product.
 */
export const fromNameFor = (app: string): string | undefined => (app === DEFAULT_APP_NAME ? undefined : app);
