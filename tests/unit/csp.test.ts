import { describe, expect, it } from "vitest";
import { buildCsp, newNonce } from "@/lib/csp";

describe("content security policy", () => {
  const csp = buildCsp("abc123==");
  const directive = (name: string) => csp.split("; ").find((d) => d.startsWith(`${name} `)) ?? "";

  it("only allows scripts that carry this request's nonce, with no unsafe-inline or unsafe-eval in production", () => {
    expect(directive("script-src")).toContain("'nonce-abc123=='");
    expect(directive("script-src")).not.toContain("unsafe-inline");
    expect(directive("script-src")).not.toContain("unsafe-eval");
  });

  it("locks down everything else", () => {
    expect(directive("default-src")).toBe("default-src 'self'");
    expect(directive("object-src")).toBe("object-src 'none'");
    expect(directive("frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive("base-uri")).toBe("base-uri 'self'");
    expect(directive("form-action")).toBe("form-action 'self'");
    expect(directive("connect-src")).toBe("connect-src 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("allows inline style attributes only, never inline style elements", () => {
    expect(directive("style-src")).toBe("style-src 'self' 'nonce-abc123=='");
    expect(directive("style-src-attr")).toBe("style-src-attr 'unsafe-inline'");
  });

  it("development additionally allows eval and websockets for hot reload, and no https upgrade", () => {
    const dev = buildCsp("n", { dev: true });
    expect(dev).toContain("'unsafe-eval'");
    expect(dev).toContain("connect-src 'self' ws:");
    expect(dev).not.toContain("upgrade-insecure-requests");
  });

  it("the HTTPS upgrade directive can be switched off for plain-http test servers", () => {
    expect(buildCsp("n", { upgrade: false })).not.toContain("upgrade-insecure-requests");
  });

  it("nonces are unpredictable and unique", () => {
    const seen = new Set(Array.from({ length: 200 }, () => newNonce()));
    expect(seen.size).toBe(200);
    for (const n of seen) expect(Buffer.from(n, "base64").length).toBe(16);
  });
});
