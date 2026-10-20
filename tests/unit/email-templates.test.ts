import { describe, expect, it } from "vitest";
import { escapeHtml, renderEmail, safeUrl } from "@/integrations/email/templates";
import { createCaptureSender } from "@/integrations/email";

describe("escapeHtml", () => {
  it("escapes the five characters that can open markup or an attribute", () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&</a>`)).toBe("&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
    expect(escapeHtml("สวัสดี 100%")).toBe("สวัสดี 100%");
  });
});

describe("safeUrl", () => {
  it("accepts http(s) links only", () => {
    expect(safeUrl("https://app.example/o/1/tasks?task=2")).toBe("https://app.example/o/1/tasks?task=2");
    expect(safeUrl("http://localhost:3000/x")).toBe("http://localhost:3000/x");
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>1</script>", "//evil.example", "/relative", "", "not a url", "ftp://x.example/f", "JAVASCRIPT:alert(1)"]) expect(safeUrl(bad), bad).toBeNull();
  });
});

const EVIL = `<img src=x onerror=alert(1)>"&'`;

describe("renderEmail", () => {
  const base = { locale: "en" as const, app: "Task Tracker", heading: "Hello", intro: ["Some text"], button: { label: "Open", url: "https://app.example/go?a=1&b=2" } };

  it("is a complete HTML document with a text twin", () => {
    const { html, text } = renderEmail(base);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<h1");
    expect(html).toContain('href="https://app.example/go?a=1&amp;b=2"'); // the ampersand of a query string is escaped in the attribute
    expect(text).toContain("Hello");
    expect(text).toContain("Open: https://app.example/go?a=1&b=2"); // not escaped in plain text
    expect(text).not.toContain("<");
  });

  it("loads nothing remote and runs nothing", () => {
    const { html } = renderEmail({ ...base, preheader: "x" });
    expect(html).not.toMatch(/<script|<link|<img|<iframe|<form|@import|url\(|javascript:/i);
  });

  it("escapes everything a person or a database row supplied, wherever it appears", () => {
    const { html, text } = renderEmail({
      locale: "th",
      app: EVIL, // the product's name is escaped too (the rules of src/domain/app-name.ts already refuse such a name, but the template does not rely on that)
      preheader: EVIL,
      heading: EVIL,
      intro: [EVIL],
      list: [EVIL],
      more: EVIL,
      footer: [EVIL],
      sections: [{ title: EVIL, tone: "overdue", lines: [{ title: EVIL, url: "https://app.example/t?x=1", details: [EVIL, EVIL], due: EVIL }] }],
      button: { label: EVIL, url: "https://app.example/b" },
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(text).toContain(EVIL); // plain text is plain: no escaping, and nothing renders it as markup
  });

  it("drops a link that is not http(s) instead of putting it in an href", () => {
    const { html, text } = renderEmail({ ...base, button: { label: "Open", url: "javascript:alert(1)" }, sections: [{ title: "S", tone: "plain", lines: [{ title: "T", url: "javascript:alert(2)", details: [], due: "d" }] }] });
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("<a "); // no link at all: not on the button, not on the task line, and no dead "#" placeholder
    expect(html).not.toContain("Open"); // the button is left out whole, not shown without a destination
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("Open:");
    expect(html).toContain(">T<"); // the title is still shown, just not linked
    expect(text).toContain("- T |  | d");
  });

  it("writes a safe task link the same way in both bodies (normalized), and nothing for an unsafe one", () => {
    const { html, text } = renderEmail({ ...base, button: undefined, sections: [{ title: "S", tone: "plain", lines: [{ title: "A", url: "https://X.example/a b?x=1&y=2", details: [], due: "d" }, { title: "B", url: "data:text/html,<b>", details: [], due: "d" }] }] });
    expect(html).toContain('href="https://x.example/a%20b?x=1&amp;y=2"');
    expect(text).toContain("  https://x.example/a%20b?x=1&y=2");
    expect(text).not.toContain("data:");
  });

  it("lets a very long unbroken title wrap inside the card instead of stretching the message", () => {
    const long = "ก".repeat(300) + "https://example.test/" + "a".repeat(300);
    const { html, text } = renderEmail({ ...base, sections: [{ title: "Overdue", tone: "overdue", lines: [{ title: long, url: "https://x.example/a", details: ["P"], due: "d" }] }] });
    expect(html).toContain(long); // shown whole, not cut
    expect(text).toContain(long);
    // the card that holds every line allows breaking anywhere, so the message cannot become wider than the 600 px column
    expect(html).toMatch(/<td style="[^"]*word-break:break-word;[^"]*overflow-wrap:anywhere;/);
    expect(html).toContain('max-width:600px');
  });

  it("lists sections with their counts and skips empty ones", () => {
    const { html, text } = renderEmail({ ...base, sections: [
      { title: "Overdue", tone: "overdue", lines: [{ title: "A", url: "https://x.example/a", details: ["P"], due: "2 days overdue" }, { title: "B", url: "https://x.example/b", details: [], due: "3 days overdue" }] },
      { title: "Never shown", tone: "today", lines: [] },
    ] });
    expect(html).toContain("Overdue (2)");
    expect(html).not.toContain("Never shown");
    expect(text).toContain("Overdue (2)");
    expect(text).toContain("- A | P | 2 days overdue");
  });
});

describe("the e-mail test double", () => {
  it("refuses a message that is not HTML, so no sender can slip back to plain text", async () => {
    const s = createCaptureSender();
    await expect(s.send({ to: "a@b.c", subject: "x", text: "plain only", html: "" })).rejects.toThrow(/HTML/);
    await expect(s.send({ to: "a@b.c", subject: "x", text: "", html: "<!doctype html><html></html>" })).rejects.toThrow();
    await s.send({ to: "a@b.c", subject: "x", text: "t", html: "<!doctype html><html></html>" });
    expect(s.sent).toHaveLength(1);
  });
});
