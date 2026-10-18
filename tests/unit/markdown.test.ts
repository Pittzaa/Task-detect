import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MAX_MARKDOWN_CHARS, linkLabelMismatch, parseMarkdown, safeUrl, type Block, type Inline } from "@/lib/markdown";
import { renderMarkdown } from "@/ui/markdown";

const html = (src: string) => renderToStaticMarkup(createElement("div", null, renderMarkdown(src)));
const inl = (src: string): Inline[] => (parseMarkdown(src)[0] as Extract<Block, { t: "p" }>).c;

describe("inline formatting", () => {
  it("bold, italic, strike and code", () => {
    expect(html("**b** *i* _j_ ~~s~~ `c`")).toBe("<div><p><strong>b</strong> <em>i</em> <em>j</em> <del>s</del> <code>c</code></p></div>");
  });
  it("nests, and keeps the text of code literal", () => {
    expect(html("**bold *and italic***")).toContain("<strong>bold <em>and italic</em></strong>");
    expect(html("`**not bold** <b>`")).toBe("<div><p><code>**not bold** &lt;b&gt;</code></p></div>");
    expect(html("`` a`b ``")).toContain("<code>a`b</code>");
  });
  it("does not mistake ordinary text for formatting", () => {
    for (const plain of ["5 * 3 * 2", "snake_case_name and __init__.py is fine", "a * b", "2 ** 8", "price is $5 ~ $6", "100% sure_", "under_score_ and_more", "email: a_b@example.com", "~single tilde~", "*", "**", "_ _", "* not emphasis *"]) {
      const out = html(plain);
      expect(out, plain).not.toMatch(/<(em|del)>/);
    }
    expect(html("snake_case_name")).toBe("<div><p>snake_case_name</p></div>");
    expect(html("5 * 3 * 2")).toBe("<div><p>5 * 3 * 2</p></div>");
  });
  it("a line break stays a line break, as it was in plain text", () => {
    expect(html("one\ntwo\n\nthree")).toBe("<div><p>one<br/>two</p><p>three</p></div>");
  });
  it("backslash escapes punctuation", () => {
    expect(html("\\*not italic\\* \\[x\\](not a link) \\`")).toBe("<div><p>*not italic* [x](not a link) `</p></div>");
  });
  it("Thai text and emoji pass through unchanged", () => {
    expect(html("สวัสดี **ครับ** 🙂")).toBe("<div><p>สวัสดี <strong>ครับ</strong> 🙂</p></div>");
  });
});

describe("blocks", () => {
  it("headings are drawn as bold paragraphs (never real headings)", () => {
    const out = html("# Title\n## Sub\n###### six\n####### seven");
    expect(out).not.toMatch(/<h\d/);
    expect(out.match(/class="md-heading"/g)).toHaveLength(3);
    expect(out).toContain("####### seven");
  });
  it("lists, ordered lists with a start number, nesting and task-like text", () => {
    expect(html("- a\n- b\n\n- c")).toBe("<div><ul><li><p>a</p></li><li><p>b</p></li><li><p>c</p></li></ul></div>");
    expect(html("3. x\n4. y")).toContain('<ol start="3">');
    const nested = html("- a\n  - b\n    - c\n- d");
    expect(nested.match(/<ul>/g)).toHaveLength(3);
    expect(nested).toContain("<li><p>a</p><ul><li><p>b</p>");
    expect(html("- [ ] todo")).toContain("[ ] todo");
  });
  it("quotes and fenced code (contents are literal, markup inside is not interpreted)", () => {
    expect(html("> quoted **bold**\n> more")).toContain("<blockquote><p>quoted <strong>bold</strong><br/>more</p></blockquote>");
    expect(html("```js\nlet a = '<script>alert(1)</script>'; // **x**\n```")).toBe("<div><pre><code>let a = &#x27;&lt;script&gt;alert(1)&lt;/script&gt;&#x27;; // **x**</code></pre></div>");
    expect(html("```\nunterminated\n**x**")).toContain("<pre><code>unterminated\n**x**</code></pre>");
  });
  it("horizontal rule", () => {
    expect(html("a\n\n---\n\nb")).toContain("<hr/>");
  });
  it("empty and whitespace-only input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("  \n\t\n")).toEqual([]);
  });
});

describe("links", () => {
  it("renders http(s) links that open safely in a new tab and name that to screen readers", () => {
    const out = html("see [the docs](https://docs.example/a?b=1&c=2) and https://x.example/path.");
    expect(out).toContain('<a href="https://docs.example/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow ugc">the docs<span class="sr-only"> (opens in a new tab)</span></a>');
    expect(out).toContain('<a href="https://x.example/path"');
    expect(out).toContain("</a>.</p>"); // the sentence's full stop is not part of the link
  });
  it("autolinks in angle brackets and balances parentheses", () => {
    expect(html("<https://a.example/x>")).toContain('href="https://a.example/x"');
    expect(html("(see https://a.example/x)")).toContain('href="https://a.example/x"');
    expect(html("https://en.wikipedia.example/wiki/Foo_(bar)")).toContain('href="https://en.wikipedia.example/wiki/Foo_(bar)"');
    expect(html("[w](https://en.wikipedia.example/wiki/Foo_(bar))")).toContain('href="https://en.wikipedia.example/wiki/Foo_(bar)"');
  });
  it("a visible address that differs from the real destination is called out", () => {
    expect(html("[https://my-bank.example](https://evil.example/login)")).toContain("[→ evil.example]");
    expect(html("[https://www.good.example/x](https://good.example/y)")).not.toContain("→");
    expect(html("[click here](https://evil.example)")).not.toContain("→");
    expect(linkLabelMismatch([{ t: "text", v: "www.a.example" }], "https://b.example/")).toBe("b.example");
  });
  it("safeUrl accepts only plain http(s) URLs", () => {
    expect(safeUrl("https://a.example/p?q=1#h")).toBe("https://a.example/p?q=1#h");
    expect(safeUrl("HTTP://A.EXAMPLE")).toBe("http://a.example/");
    expect(safeUrl("  https://a.example/  ")).toBe("https://a.example/"); // surrounding whitespace is dropped, never kept inside
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:x", "file:///etc/passwd", "ftp://a.example", "//evil.example", "/relative", "#frag", "mailto:a@b.c", "https://user:pw@a.example", "https://a.example/ x", "https://a.example/\u0000", "https:///x", "https://", "http://a.example\"onmouseover=\"x", "https://a.example/<b>", "java\tscript:alert(1)", " javascript:alert(1)", "https://a.example/\u2028x", "x".repeat(3000)]) expect(safeUrl(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
  });
});

describe("hostile input (XSS corpus)", () => {
  const corpus = [
    "<script>alert(1)</script>", "<img src=x onerror=alert(1)>", "<svg onload=alert(1)>", "<a href=\"javascript:alert(1)\">x</a>", "<iframe src=//evil.example></iframe>",
    "[x](javascript:alert(1))", "[x](JaVaScRiPt:alert(1))", "[x]( javascript:alert(1))", "[x](java\tscript:alert(1))", "[x](&#106;avascript:alert(1))", "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[x](//evil.example)", "[x](https://a.example\" onmouseover=\"alert(1))", "[x](https://a.example' onmouseover='alert(1))", "[x](<javascript:alert(1)>)", "<javascript:alert(1)>",
    "![x](https://evil.example/pixel.gif)", "![x](javascript:alert(1))", "![<img src=x onerror=alert(1)>](https://a.example)", "[<script>alert(1)</script>](https://a.example)",
    "**<script>**", "`<script>`", "> <script>alert(1)</script>", "- <script>alert(1)</script>", "# <script>alert(1)</script>", "```\n</code></pre><script>alert(1)</script>\n```",
    "[a](https://a.example)](javascript:alert(1))", "[[x](javascript:alert(1))](https://a.example)", "&lt;script&gt;alert(1)&lt;/script&gt;", "\u202egnp.exe", "</p><script>alert(1)</script>",
    "[x](https://a.example/%0d%0aSet-Cookie:x)", "https://a.example/<script>", "https://a.example/\"><script>alert(1)</script>",
  ];
  const ALLOWED_TAGS = new Set(["div", "p", "br", "strong", "em", "del", "code", "pre", "a", "ul", "ol", "li", "blockquote", "hr", "span"]);

  it.each(corpus)("produces only allowed elements and attributes: %s", (src) => {
    const out = html(src);
    const tags = [...out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]!.toLowerCase());
    expect(tags.filter((t) => !ALLOWED_TAGS.has(t)), out).toEqual([]);
    // every attribute that exists is one we put there: href/target/rel on links, class, start on lists
    const attrs = [...out.matchAll(/<[a-z]+\s([^>]*)>/g)].flatMap((m) => [...m[1]!.matchAll(/([a-zA-Z-]+)=/g)].map((a) => a[1]));
    expect(attrs.filter((a) => !["href", "target", "rel", "class", "start"].includes(a!)), out).toEqual([]);
    for (const m of out.matchAll(/<a ([^>]*)>/g)) {
      expect(m[1], out).toMatch(/^href="https?:\/\/[^"<>\s]*" target="_blank" rel="noopener noreferrer nofollow ugc"$/);
    }
    expect(out).not.toMatch(/<img|<script|<iframe|<svg|<style/i); // (visible text such as "onerror=" is harmless: only real attributes matter, checked above)
    expect(out).not.toMatch(/href="(?!https?:\/\/)/i);
  });

  it("shows hostile markup as visible text rather than dropping or running it", () => {
    expect(html("<script>alert(1)</script>")).toBe("<div><p>&lt;script&gt;alert(1)&lt;/script&gt;</p></div>");
    expect(html("[x](javascript:alert(1))")).toBe("<div><p>[x](javascript:alert(1))</p></div>");
    expect(html("![pixel](https://evil.example/p.gif)")).not.toContain("<img");
  });

  it("never throws, whatever it is given", () => {
    const junk = ["", "\u0000", "[", "]", "[]", "[]()", "[](", "![", "![]()", "``", "```", "***", "___", "~~", "> > > > > > > > > > >", "- - - - - -", "1. 1. 1. 1.", "<", "<<<>>>", "\\", "\\\\\\", "[a](b", "[a](<", "(", ")", "\ud800", "\n\n\n", "#", "# ", "---", "***", "* * *"];
    for (const j of junk) expect(() => html(j), JSON.stringify(j)).not.toThrow();
  });
});

describe("resource limits (hostile input must not hang the page)", () => {
  const budget = (label: string, src: string) => {
    const t = performance.now();
    const out = html(src);
    const ms = performance.now() - t;
    expect(ms, `${label}: ${Math.round(ms)} ms`).toBeLessThan(300);
    return out;
  };
  it.each([
    ["many unmatched openers", "*a ".repeat(6000)],
    ["many unmatched brackets", "[".repeat(15000)],
    ["unmatched link targets", "[a](".repeat(4000)],
    ["unmatched backticks of growing length", Array.from({ length: 200 }, (_, i) => "`".repeat(i + 1)).join(" a ")],
    ["deep quote nesting", "> ".repeat(8000) + "x"],
    ["deep list nesting", Array.from({ length: 400 }, (_, i) => " ".repeat(i * 2) + "- x").join("\n")],
    ["many list items", Array.from({ length: 5000 }, (_, i) => `- item ${i}`).join("\n")],
    ["deep emphasis nesting", "*a ".repeat(3000) + "b" + "* ".repeat(3000)],
    ["long single line", "word ".repeat(4000)],
    ["many autolinks", "https://a.example/x ".repeat(900)],
    ["many fences", "```\n".repeat(5000)],
    ["very long tilde runs", "~".repeat(MAX_MARKDOWN_CHARS)],
  ])("%s", (label, src) => { budget(label, src); });

  it("input over the limit is cut, not processed in full", () => {
    const out = budget("oversize", "a".repeat(MAX_MARKDOWN_CHARS * 5));
    expect(out.length).toBeLessThan(MAX_MARKDOWN_CHARS + 100);
  });

  it("deep nesting is flattened to text instead of recursing without end", () => {
    const tree = parseMarkdown("> ".repeat(50) + "deep");
    let depth = 0;
    for (let n: Block | undefined = tree[0]; n && n.t === "quote"; n = n.c[0]) depth++;
    expect(depth).toBeLessThanOrEqual(8);
  });
});

describe("tree shape", () => {
  it("text stays text: plain comments render exactly as they were typed", () => {
    for (const plain of ["Looks good, thanks!", "@Sam Member please review", "Due 2026-07-01 (see ticket #123)", "a < b and c > d & e", "100% done; costs $5.00 — ok?", "ไทย English 123"]) {
      const out = html(plain);
      expect(out.replace(/<\/?[a-z]+[^>]*>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")).toBe(plain);
    }
  });
  it("inline nodes are what the renderer expects", () => {
    expect(inl("a **b** c")).toEqual([{ t: "text", v: "a " }, { t: "strong", c: [{ t: "text", v: "b" }] }, { t: "text", v: " c" }]);
  });
});
