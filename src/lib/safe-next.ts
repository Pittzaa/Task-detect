/**
 * Where to go after signing in: only a path on this site. The value comes from the address bar, so it is treated as hostile.
 * Browsers' URL parsers silently drop tab, line feed and carriage return, so "/<TAB>/host" is read as "//host" (another site);
 * control characters, whitespace and backslashes are therefore refused outright, as is anything that starts "//".
 */
const FORBIDDEN = new RegExp("[\\u0000-\\u0020\\u007f-\\u009f\\u2028\\u2029\\\\]");

export function safeNext(next: string | null | undefined): string {
  if (!next || next.length > 2048 || !next.startsWith("/") || next.startsWith("//") || FORBIDDEN.test(next)) return "/";
  // belt and braces: resolved against any origin, it must stay on that origin
  try { if (new URL(next, "https://same-site.invalid").origin !== "https://same-site.invalid") return "/"; } catch { return "/"; }
  return next;
}
