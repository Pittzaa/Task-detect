/**
 * A small, safe Markdown parser for comments and task descriptions.
 *
 * It produces a typed tree, never HTML: the renderer builds React elements from it, so no string of markup is ever
 * concatenated or inserted. Raw HTML in the source stays literal text. Only a fixed set of constructs exists (below), links are
 * limited to http(s), images are not embedded (they become links), and there is a hard work budget so hostile input cannot make
 * the browser or server spin.
 *
 * Supported: paragraphs (a line break stays a line break, as in plain text), `#` headings, **bold**, *italic*, _italic_, ~~strike~~,
 * `code`, fenced code blocks, > quotes, - / * / + and 1. lists (nested by indentation), --- rules, [text](https://url) and bare
 * https:// links, backslash escapes. Not supported on purpose: HTML, tables, images, footnotes, reference links.
 */
export type Inline =
  | { t: "text"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] }
  | { t: "br" };

export type Block =
  | { t: "p"; c: Inline[] }
  | { t: "heading"; level: number; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "quote"; c: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: Block[][] }
  | { t: "hr" };

export const MAX_MARKDOWN_CHARS = 20_000;
const MAX_DEPTH = 5;
const STEP_BUDGET = 300_000;

interface Budget { steps: number }
const spend = (b: Budget, n = 1) => { b.steps -= n; return b.steps > 0; };

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

// whitespace, control characters and the Unicode line separators: never part of a URL we will emit
const UNSAFE_URL_CHARS = new RegExp("[\\u0000-\\u0020\\u007f-\\u009f\\u2028\\u2029]");

/** Returns a normalized http(s) URL, or null. No credentials in the URL (they make `https://good.example@evil.example` look legitimate). */
export function safeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || s.length > 2000 || UNSAFE_URL_CHARS.test(s) || /[<>"'`\\]/.test(s)) return null;
  if (!/^https?:\/\/[^/]/i.test(s)) return null;
  try {
    const u = new URL(s);
    if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || !u.hostname) return null;
    return u.href;
  } catch { return null; }
}

const hostOf = (href: string) => { try { return new URL(href).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };
const plainOf = (nodes: Inline[]): string => nodes.map((n) => (n.t === "text" || n.t === "code" ? n.v : n.t === "br" ? " " : plainOf(n.c))).join("");

/** `[https://bank.example](https://evil.example)`: the visible text names one place, the link goes to another. */
export function linkLabelMismatch(label: Inline[], href: string): string | null {
  const text = plainOf(label).trim();
  const m = /^(?:https?:\/\/|www\.)([^\s/?#]+)/i.exec(text);
  if (!m) return null;
  const shown = m[1]!.toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");
  const real = hostOf(href);
  return shown && real && shown !== real ? real : null;
}

// ---------------------------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------------------------

const PUNCT = /[!-/:-@[-`{-~]/;
const isWordChar = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

function pushText(out: Inline[], v: string) {
  if (!v) return;
  const last = out[out.length - 1];
  if (last && last.t === "text") last.v += v; else out.push({ t: "text", v });
}

/** Position of the `]` that closes the `[` at `open` (nesting aware), or -1. */
function closingBracket(s: string, open: number, b: Budget): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (!spend(b)) return -1;
    const ch = s[i];
    if (ch === "\\") { i++; continue; }
    if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return i;
  }
  return -1;
}

/** `(url "title")` starting at `(`: returns the url text and the index after `)`, or null. */
function linkTarget(s: string, open: number, b: Budget): { url: string; end: number } | null {
  let i = open + 1;
  while (s[i] === " ") i++;
  let url = "";
  if (s[i] === "<") {
    const close = s.indexOf(">", i + 1);
    if (close < 0 || s.slice(i + 1, close).includes("\n")) return null;
    url = s.slice(i + 1, close);
    i = close + 1;
  } else {
    let depth = 0;
    const start = i;
    for (; i < s.length; i++) {
      if (!spend(b)) return null;
      const ch = s[i]!;
      if (ch === "\\") { i++; continue; }
      if (/\s/.test(ch)) break;
      if (ch === "(") depth++;
      else if (ch === ")") { if (depth === 0) break; depth--; }
    }
    url = s.slice(start, i).replace(/\\([!-/:-@[-`{-~])/g, "$1");
  }
  while (s[i] === " ") i++;
  if (s[i] === '"' || s[i] === "'") { // optional title, ignored
    const q = s[i]!;
    const close = s.indexOf(q, i + 1);
    if (close < 0) return null;
    i = close + 1;
    while (s[i] === " ") i++;
  }
  return s[i] === ")" ? { url, end: i + 1 } : null;
}

function parseInline(src: string, b: Budget, depth = 0, inLink = false): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  while (i < src.length) {
    if (!spend(b)) { pushText(out, src.slice(i)); break; }
    const ch = src[i]!;

    if (ch === "\n") { out.push({ t: "br" }); i++; continue; }

    if (ch === "\\" && i + 1 < src.length && PUNCT.test(src[i + 1]!)) { pushText(out, src[i + 1]!); i += 2; continue; }

    if (ch === "`") {
      let n = 1; while (src[i + n] === "`") n++;
      // the closing run must be exactly as long as the opening one
      let found = -1;
      for (let from = i + n; ;) {
        const k = src.indexOf("`", from);
        if (k < 0 || !spend(b)) break;
        let m = 1; while (src[k + m] === "`") m++;
        if (m === n) { found = k; break; }
        from = k + m;
      }
      if (found >= 0) {
        let v = src.slice(i + n, found).replace(/\n/g, " ");
        if (v.length > 2 && v.startsWith(" ") && v.endsWith(" ") && v.trim()) v = v.slice(1, -1);
        out.push({ t: "code", v });
        i = found + n;
        continue;
      }
      pushText(out, "`".repeat(n)); i += n; continue;
    }

    if ((ch === "[" || (ch === "!" && src[i + 1] === "[")) && depth < MAX_DEPTH) {
      const image = ch === "!";
      const open = image ? i + 1 : i;
      const close = closingBracket(src, open, b);
      if (close > 0 && src[close + 1] === "(") {
        const target = linkTarget(src, close + 1, b);
        const href = target ? safeUrl(target.url) : null;
        if (target && href && !inLink) {
          const label = parseInline(src.slice(open + 1, close), b, depth + 1, true);
          out.push({ t: "link", href, c: label.length ? label : [{ t: "text", v: href }] });
          i = target.end;
          continue;
        }
      }
      pushText(out, ch); i++; continue;
    }

    if (ch === "<") {
      const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(src.slice(i, i + 2100));
      const href = m ? safeUrl(m[1]!) : null;
      if (m && href && !inLink) { out.push({ t: "link", href, c: [{ t: "text", v: m[1]! }] }); i += m[0].length; continue; }
      pushText(out, ch); i++; continue;
    }

    if ((ch === "h" || ch === "H") && !inLink && !isWordChar(src[i - 1]) && /^https?:\/\/[^\s<>]/i.test(src.slice(i, i + 9))) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(src.slice(i, i + 2100))!; // non-null: the test above has seen a first character after "//"
      let url = m[0];
      // trailing punctuation belongs to the sentence, and an unbalanced ")" to the surrounding parentheses
      for (;;) {
        const last = url[url.length - 1];
        if (last && /[.,;:!?'"*_~]/.test(last)) url = url.slice(0, -1);
        else if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
        else break;
      }
      const href = safeUrl(url);
      if (href) { out.push({ t: "link", href, c: [{ t: "text", v: url }] }); i += url.length; continue; }
      pushText(out, src.slice(i, i + m[0].length)); i += m[0].length; continue;
    }

    if ((ch === "*" || ch === "_" || ch === "~") && depth < MAX_DEPTH) {
      let run = 1; while (src[i + run] === ch) run++;
      const want = ch === "~" ? (run >= 2 ? 2 : 0) : Math.min(run, 2);
      const mark = ch.repeat(want);
      const opens = want > 0 && !isSpace(src[i + want]) && !(ch === "_" && isWordChar(src[i - 1]));
      if (opens) {
        let close = -1;
        for (let from = i + want; ;) {
          const k = src.indexOf(mark, from);
          if (k < 0 || !spend(b)) break;
          const prev = src[k - 1];
          const next = src[k + want];
          const closes = k > i + want && !isSpace(prev) && (ch !== "_" || !isWordChar(next)) && (want === 2 || (next !== ch && prev !== ch));
          if (closes) { close = k; if (want === 2) while (src[close + 2] === ch) close++; break; } // "***" closes "**" with the LAST two stars
          from = k + 1;
        }
        if (close > 0) {
          out.push({ t: ch === "~" ? "del" : want === 2 ? "strong" : "em", c: parseInline(src.slice(i + want, close), b, depth + 1, inLink) });
          i = close + want;
          continue;
        }
      }
      pushText(out, ch.repeat(run)); i += run; continue;
    }

    // plain run up to the next character that could start something
    let j = i + 1;
    while (j < src.length && !"\n\\`[!<*_~hH".includes(src[j]!)) j++;
    pushText(out, src.slice(i, j));
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

const FENCE = /^ {0,3}(`{3,}|~{3,})[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])([ \t]+)(.*)$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const startsBlock = (line: string) => FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line);

function parseBlocks(lines: string[], b: Budget, depth: number): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!spend(b, 2)) { out.push({ t: "p", c: [{ t: "text", v: lines.slice(i).join("\n") }] }); break; }
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i]!.trim().startsWith(mark[0]!.repeat(mark.length)) && /^[`~]+\s*$/.test(lines[i]!.trim()))) { body.push(lines[i]!); i++; spend(b); }
      i++; // closing fence (or the end)
      out.push({ t: "code", v: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) { out.push({ t: "heading", level: heading[1]!.length, c: parseInline(heading[2]!, b) }); i++; continue; }

    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && (QUOTE.test(lines[i]!) || (lines[i]!.trim() && inner.length && !startsBlock(lines[i]!)))) { inner.push(lines[i]!.replace(QUOTE, "")); i++; }
      out.push({ t: "quote", c: depth < MAX_DEPTH ? parseBlocks(inner, b, depth + 1) : [{ t: "p", c: [{ t: "text", v: inner.join("\n") }] }] });
      continue;
    }

    const item = ITEM.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]![0]!);
      const marker = ordered ? item[2]!.slice(-1) : item[2]!;
      const start = ordered ? Number.parseInt(item[2]!, 10) : 1;
      const items: Block[][] = [];
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]!);
        if (!m || (ordered ? !/\d/.test(m[2]![0]!) || m[2]!.slice(-1) !== marker : m[2] !== marker) || m[1]!.length > 3) break;
        const pad = m[1]!.length + m[2]!.length + m[3]!.length;
        const body = [m[4]!];
        i++;
        // continuation: lines indented to the item's text; a blank line only continues the item if indented text follows; a non-indented
        // line that does not start another block continues the paragraph ("lazy" continuation)
        while (i < lines.length) {
          const l = lines[i]!;
          if (!l.trim()) {
            let k = i; while (k < lines.length && !lines[k]!.trim()) k++;
            if (k < lines.length && indentOf(lines[k]!) >= pad) { for (; i < k; i++) body.push(""); continue; }
            break;
          }
          if (indentOf(l) >= pad) { body.push(l.slice(pad)); i++; spend(b); continue; }
          if (body[body.length - 1] !== "" && !startsBlock(l)) { body.push(l); i++; spend(b); continue; }
          break;
        }
        items.push(depth < MAX_DEPTH ? parseBlocks(body, b, depth + 1) : [{ t: "p", c: [{ t: "text", v: body.join("\n") }] }]);
        // a single blank line between items keeps them in one list
        if (i < lines.length && !lines[i]!.trim()) {
          let k = i; while (k < lines.length && !lines[k]!.trim()) k++;
          const next = k < lines.length ? ITEM.exec(lines[k]!) : null;
          if (next && (ordered ? /\d/.test(next[2]![0]!) && next[2]!.slice(-1) === marker : next[2] === marker)) i = k; else break;
        }
        if (items.length >= 500) break;
      }
      out.push({ t: "list", ordered, start, items });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim() && (para.length === 0 || !startsBlock(lines[i]!))) { para.push(lines[i]!.replace(/^[ \t]+/, "")); i++; spend(b); }
    out.push({ t: "p", c: parseInline(para.map((l) => l.replace(/[ \t]+$/, "")).join("\n"), b) });
  }
  return out;
}

export function parseMarkdown(source: string): Block[] {
  const text = source.length > MAX_MARKDOWN_CHARS ? source.slice(0, MAX_MARKDOWN_CHARS) : source;
  const lines = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "").replace(/\t/g, "    ").split("\n");
  return parseBlocks(lines, { steps: STEP_BUDGET }, 0);
}
