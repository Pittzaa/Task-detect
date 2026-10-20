import { t, type Locale } from "@/i18n";

/**
 * Every e-mail the application sends is an HTML message with a plain-text twin made from the same content (mail clients that cannot show
 * HTML, and spam filters, expect both). One layout, table based with inline styles because that is what mail clients render reliably:
 * no scripts, no external images or fonts, nothing remote to load.
 *
 * Everything a person or a database row supplied (names, task titles, project names, organization names) goes through `escapeHtml`;
 * links go through `safeUrl`. The layout takes plain strings, never HTML, so a caller cannot forget to escape.
 */

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** http(s) links only, normalized by the URL parser; anything else is dropped (returns null). */
export function safeUrl(u: string): string | null {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export type Tone = "overdue" | "today" | "soon" | "plain";

export interface TaskLine {
  title: string;
  url: string;
  /** Free-text facts shown under the title, in order: project, status, priority... */
  details: string[];
  /** The due label on the right: a date, "today", "3 days overdue". */
  due: string;
}

export interface Section {
  title: string;
  tone: Tone;
  lines: TaskLine[];
  /** The full number when `lines` is only the first part of it: the title then reads "(30 / 35)". */
  total?: number;
}

const countOf = (s: Section) => (s.total !== undefined && s.total > s.lines.length ? `${s.lines.length} / ${s.total}` : String(s.lines.length));

export interface Layout {
  locale: Locale;
  /** The product's name for this message (src/domain/app-name.ts): the header line and the "sent automatically by ..." footer. Required, so a caller cannot forget it. */
  app: string;
  /** The inbox preview line, not shown in the body. */
  preheader?: string;
  heading: string;
  /** Paragraphs of plain text. */
  intro?: string[];
  sections?: Section[];
  /** Plain-text bullet lines (digests). */
  list?: string[];
  /** Shown under the sections/list when more exist than were listed. */
  more?: string;
  button?: { label: string; url: string };
  /** Small print at the bottom, one line each. */
  footer?: string[];
}

const BRAND = "#4338ca";
const TEXT = "#1f2430";
const MUTED = "#5b6475";
const BORDER = "#e4e7ee";
const TONES: Record<Tone, { fg: string; bg: string }> = {
  overdue: { fg: "#b42318", bg: "#fef3f2" },
  today: { fg: "#b54708", bg: "#fffaeb" },
  soon: { fg: "#175cd3", bg: "#eff8ff" },
  plain: { fg: MUTED, bg: "#f4f5f8" },
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans Thai','Sarabun',Helvetica,Arial,sans-serif";

function paragraph(text: string): string {
  return `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:${TEXT};">${escapeHtml(text)}</p>`;
}

function taskLine(l: TaskLine, tone: Tone): string {
  const url = safeUrl(l.url);
  const title = url ? `<a href="${escapeHtml(url)}" style="color:${TEXT};text-decoration:none;font-weight:600;">${escapeHtml(l.title)}</a>` : `<span style="font-weight:600;color:${TEXT};">${escapeHtml(l.title)}</span>`;
  const c = TONES[tone];
  return `<tr>
<td style="padding:10px 0;border-top:1px solid ${BORDER};vertical-align:top;font-size:14px;line-height:1.5;">${title}<br><span style="font-size:13px;color:${MUTED};">${escapeHtml(l.details.filter(Boolean).join(" · "))}</span></td>
<td align="right" style="padding:10px 0 10px 12px;border-top:1px solid ${BORDER};vertical-align:top;white-space:nowrap;"><span style="display:inline-block;padding:2px 9px;border-radius:999px;background:${c.bg};color:${c.fg};font-size:12px;font-weight:600;">${escapeHtml(l.due)}</span></td>
</tr>`;
}

function section(s: Section): string {
  const c = TONES[s.tone];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 18px;">
<tr><td colspan="2" style="padding:0 0 6px;font-size:13px;font-weight:700;letter-spacing:.02em;color:${c.fg};">${escapeHtml(s.title)} (${countOf(s)})</td></tr>
${s.lines.map((l) => taskLine(l, s.tone)).join("\n")}
</table>`;
}

/** The HTML and plain-text bodies of one message. */
export function renderEmail(l: Layout): { html: string; text: string } {
  const app = l.app;
  const button = l.button && safeUrl(l.button.url) ? { label: l.button.label, url: safeUrl(l.button.url)! } : null;

  const body: string[] = [];
  for (const p of l.intro ?? []) body.push(paragraph(p));
  for (const s of l.sections ?? []) if (s.lines.length) body.push(section(s));
  if (l.list?.length) body.push(`<ul style="margin:0 0 14px;padding:0 0 0 20px;font-size:15px;line-height:1.6;color:${TEXT};">${l.list.map((x) => `<li style="margin:0 0 6px;">${escapeHtml(x)}</li>`).join("")}</ul>`);
  if (l.more) body.push(`<p style="margin:0 0 14px;font-size:14px;color:${MUTED};">${escapeHtml(l.more)}</p>`);
  if (button) {
    body.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 18px;"><tr><td style="border-radius:8px;background:${BRAND};"><a href="${escapeHtml(button.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(button.label)}</a></td></tr></table>`);
    body.push(`<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${MUTED};">${escapeHtml(t(l.locale, "email.fallback_link"))}<br><a href="${escapeHtml(button.url)}" style="color:${BRAND};word-break:break-all;">${escapeHtml(button.url)}</a></p>`);
  }
  const footer = [...(l.footer ?? []), t(l.locale, "email.footer.automatic", { app })];

  const html = `<!doctype html>
<html lang="${l.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<title>${escapeHtml(l.heading)}</title>
</head>
<body style="margin:0;padding:0;background:#f3f4f8;font-family:${FONT};">
${l.preheader ? `<span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(l.preheader)}</span>` : ""}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f8;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">
<tr><td style="padding:0 4px 12px;font-size:15px;font-weight:700;color:${BRAND};">${escapeHtml(app)}</td></tr>
<tr><td style="background:#ffffff;border:1px solid ${BORDER};border-radius:12px;padding:28px;word-break:break-word;overflow-wrap:anywhere;">
<h1 style="margin:0 0 16px;font-size:20px;line-height:1.35;color:${TEXT};">${escapeHtml(l.heading)}</h1>
${body.join("\n")}
</td></tr>
<tr><td style="padding:14px 4px 0;font-size:12px;line-height:1.6;color:${MUTED};">${footer.map(escapeHtml).join("<br>")}</td></tr>
</table>
</td></tr></table>
</body>
</html>`;

  const text: string[] = [l.heading, ""];
  for (const p of l.intro ?? []) text.push(p, "");
  for (const s of l.sections ?? []) {
    if (!s.lines.length) continue;
    text.push(`${s.title} (${countOf(s)})`);
    for (const x of s.lines) {
      text.push(`- ${x.title} | ${x.details.filter(Boolean).join(" | ")} | ${x.due}`);
      const url = safeUrl(x.url); // the plain-text twin follows the same rule as the HTML: an unsafe address is left out, a safe one is written as normalized
      if (url) text.push(`  ${url}`);
    }
    text.push("");
  }
  for (const x of l.list ?? []) text.push(`- ${x}`);
  if (l.list?.length) text.push("");
  if (l.more) text.push(l.more, "");
  if (button) text.push(`${button.label}: ${button.url}`, "");
  text.push(...footer);
  return { html, text: text.join("\n") };
}
