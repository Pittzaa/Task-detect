import { describe, expect, it } from "vitest";
import { parseWebhookUrl, plain, postWebhook } from "@/integrations/discord";

const ID = "123456789012345678";
const TOKEN = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ0123456789-_";

describe("webhook URL validation (SSRF guard)", () => {
  it("accepts canonical discord.com / discordapp.com URLs and returns a short hint", () => {
    expect(parseWebhookUrl(`https://discord.com/api/webhooks/${ID}/${TOKEN}`)).toEqual({ ok: true, hint: "89-_" });
    expect(parseWebhookUrl(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`).ok).toBe(true);
  });
  it.each([
    ["http scheme", `http://discord.com/api/webhooks/${ID}/${TOKEN}`],
    ["other host", `https://example.com/api/webhooks/${ID}/${TOKEN}`],
    ["lookalike suffix", `https://discord.com.evil.com/api/webhooks/${ID}/${TOKEN}`],
    ["lookalike prefix", `https://evildiscord.com/api/webhooks/${ID}/${TOKEN}`],
    ["userinfo", `https://discord.com@evil.com/api/webhooks/${ID}/${TOKEN}`],
    ["port", `https://discord.com:8443/api/webhooks/${ID}/${TOKEN}`],
    ["query string", `https://discord.com/api/webhooks/${ID}/${TOKEN}?thread_id=1`],
    ["fragment", `https://discord.com/api/webhooks/${ID}/${TOKEN}#x`],
    ["extra path", `https://discord.com/api/webhooks/${ID}/${TOKEN}/github`],
    ["IPv4 host", `https://127.0.0.1/api/webhooks/${ID}/${TOKEN}`],
    ["localhost", `https://localhost/api/webhooks/${ID}/${TOKEN}`],
    ["metadata service", `https://169.254.169.254/api/webhooks/${ID}/${TOKEN}`],
    ["short token", `https://discord.com/api/webhooks/${ID}/short`],
    ["non-numeric id", `https://discord.com/api/webhooks/abc/${TOKEN}`],
    ["newline injection", `https://discord.com/api/webhooks/${ID}/${TOKEN}\nHost: evil`],
    ["empty", ""],
    ["too long", "https://discord.com/api/webhooks/" + "1".repeat(400)],
  ])("rejects %s", (_n, url) => expect(parseWebhookUrl(url).ok).toBe(false));
});

describe("sending", () => {
  const URL_OK = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;
  it("refuses to send to an invalid URL without calling fetch", async () => {
    let called = false;
    const r = await postWebhook((async () => { called = true; return new Response(); }) as typeof fetch, "https://evil.example/x", "hi");
    expect(r).toEqual({ status: "invalid" });
    expect(called).toBe(false);
  });
  it("disables mention parsing, does not follow redirects, and truncates", async () => {
    let init: RequestInit | undefined;
    await postWebhook((async (_u: unknown, i: RequestInit) => { init = i; return new Response(null, { status: 204 }); }) as typeof fetch, URL_OK, "@everyone " + "x".repeat(5000));
    const body = JSON.parse(init!.body as string);
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(body.content.length).toBeLessThanOrEqual(1900);
    expect(init!.redirect).toBe("error");
  });
  it("classifies responses", async () => {
    const mk = (status: number, headers: Record<string, string> = {}, body = "") => (async () => new Response(status === 204 || status === 304 ? null : body, { status, headers })) as typeof fetch;
    expect(await postWebhook(mk(204), URL_OK, "x")).toEqual({ status: "sent" });
    expect(await postWebhook(mk(429, { "retry-after": "2" }), URL_OK, "x")).toEqual({ status: "rate_limited", retryAfterMs: 2000 });
    expect(await postWebhook(mk(429, {}, JSON.stringify({ retry_after: 1.5 })), URL_OK, "x")).toEqual({ status: "rate_limited", retryAfterMs: 1500 });
    expect(await postWebhook(mk(404), URL_OK, "x")).toEqual({ status: "invalid" });
    expect(await postWebhook(mk(401), URL_OK, "x")).toEqual({ status: "invalid" });
    expect(await postWebhook(mk(500), URL_OK, "x")).toEqual({ status: "error", retryable: true });
    expect(await postWebhook(mk(400), URL_OK, "x")).toEqual({ status: "error", retryable: false });
    expect(await postWebhook((async () => { throw new Error("net"); }) as typeof fetch, URL_OK, "x")).toEqual({ status: "error", retryable: true });
    expect(await postWebhook((async () => new Response("", { status: 302 })) as typeof fetch, URL_OK, "x")).toEqual({ status: "error", retryable: false });
  });
  it("neutralises markdown and mention characters in user text", () => {
    expect(plain("**bold** @everyone `code` > quote ~~s~~")).not.toMatch(/[*@`>~]/);
    expect(plain("a\n\nb\u0000c")).toBe("a b c");
    expect(plain("x".repeat(500), 50)).toHaveLength(50);
  });
});
