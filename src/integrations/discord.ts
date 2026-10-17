/**
 * Discord incoming-webhook client.
 *
 * SSRF defence: a webhook URL is accepted only if it is HTTPS on discord.com / discordapp.com with the exact
 * /api/webhooks/{id}/{token} shape (no ports, credentials, query or fragment), and redirects are never followed.
 * Messages disable all mention parsing so user-controlled text can never ping @everyone or roles.
 *
 * Verified against a local stub only; NOT exercised against the real Discord API in this repository's tests.
 */
const WEBHOOK = /^https:\/\/(?:discord|discordapp)\.com\/api\/webhooks\/(\d{15,25})\/([A-Za-z0-9_-]{30,120})$/;

export function parseWebhookUrl(raw: string): { ok: true; hint: string } | { ok: false } {
  if (raw.length > 300) return { ok: false };
  const m = WEBHOOK.exec(raw);
  if (!m) return { ok: false };
  return { ok: true, hint: m[2]!.slice(-4) };
}

export type PostResult =
  | { status: "sent" }
  | { status: "rate_limited"; retryAfterMs: number }
  | { status: "invalid" } // 401/403/404: the webhook was deleted or the token rotated
  | { status: "error"; retryable: boolean };

export async function postWebhook(fetchImpl: typeof fetch, url: string, content: string): Promise<PostResult> {
  if (!parseWebhookUrl(url).ok) return { status: "invalid" };
  let res: Response;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] }, flags: 4 /* suppress embeds */ }),
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { status: "error", retryable: true };
  }
  if (res.status >= 200 && res.status < 300) return { status: "sent" };
  if (res.status === 429) {
    const header = Number(res.headers.get("retry-after"));
    let ms = Number.isFinite(header) && header > 0 ? header * 1000 : 0;
    if (!ms) {
      try { ms = Number(((await res.json()) as { retry_after?: number }).retry_after ?? 1) * 1000; } catch { ms = 1000; }
    }
    return { status: "rate_limited", retryAfterMs: Math.min(Math.max(ms, 500), 3_600_000) };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) return { status: "invalid" };
  return { status: "error", retryable: res.status >= 500 };
}

/** Strip characters that could break out of the intended message layout. Mentions are neutralised by allowed_mentions too. */
export function plain(text: string, max = 120): string {
  return text.replace(/[\u0000-\u001f\u007f`*_~|>\\@]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}
