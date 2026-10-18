import { describe, expect, it } from "vitest";
import { safeNext } from "@/lib/safe-next";

describe("safeNext", () => {
  it("keeps ordinary same-site paths, with query strings and fragments", () => {
    for (const ok of ["/", "/o/abc/tasks?task=123", "/invite?token=Ab-_09", "/security", "/o/x/tasks?a=1&b=%2F%2Fevil.example#top", "/%2f%2fevil.example"]) expect(safeNext(ok), ok).toBe(ok);
  });

  it("falls back to the home page for everything that could leave the site", () => {
    const hostile = [
      "//evil.example/x", "///evil.example", "////evil.example", "https://evil.example/x", "http://evil.example", "javascript:alert(1)", "data:text/html,boo",
      "/\\evil.example", "\\\\evil.example", "/\\/evil.example",
      "/\t/evil.example/x", "/\n/evil.example/x", "/\r/evil.example/x", "/\r\n/evil.example", "/\u000b/evil.example", "/\u000c/evil.example",
      "/ /evil.example", "/\u0000/evil.example", "/\u007f/evil.example", "/\u0085/evil.example", "/ /evil.example", "/ /evil.example",
      "evil.example", "", "x", " /ok", "/ok ", "/" + "a".repeat(3000),
    ];
    for (const h of hostile) expect(safeNext(h), JSON.stringify(h).slice(0, 40)).toBe("/");
    expect(safeNext(null)).toBe("/");
    expect(safeNext(undefined)).toBe("/");
  });

  it("agrees with a real URL parser: whatever it returns resolves to the same origin", () => {
    const pieces = ["/", "\t", "\n", "\r", "\\", "evil.example", "a", ":", "@", "%2f", "?", "#", " ", "\u0000", "..", "."];
    let seed = 7;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    for (let n = 0; n < 20_000; n++) {
      let s = "";
      for (let k = 1 + Math.floor(rnd() * 8); k > 0; k--) s += pieces[Math.floor(rnd() * pieces.length)];
      const out = safeNext(s);
      expect(new URL(out, "https://app.example").origin, JSON.stringify(s)).toBe("https://app.example");
    }
  });
});
