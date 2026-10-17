import { createHash } from "node:crypto";
import { addDays } from "@/domain/time";

/**
 * Google Calendar client. ONE-WAY: this module only ever creates, updates and deletes events that we own.
 * It has no function that reads events back, so nothing in Google Calendar can change a task.
 *
 * Verified against a local stub only; NOT exercised against the real Google APIs in this repository's tests.
 */
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authUrl?: string;
  tokenUrl?: string;
  revokeUrl?: string;
  apiBase?: string;
}

export class GoogleError extends Error {
  constructor(readonly kind: "revoked" | "rate_limited" | "transient" | "permanent", readonly status: number, readonly retryAfterMs?: number) {
    super(kind);
    this.name = "GoogleError";
  }
}

/**
 * Event ids are chosen by us (base32hex, 5-1024 chars) from (connection, task). Creating twice cannot yield two events:
 * the second insert gets 409 and we update the existing one instead.
 */
export function eventIdFor(connectionId: string, taskId: string): string {
  const digest = createHash("sha256").update(`${connectionId}:${taskId}`).digest();
  const alphabet = "0123456789abcdefghijklmnopqrstuv";
  let bits = 0, value = 0, out = "";
  for (const byte of digest.subarray(0, 20)) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  return out;
}

export interface EventBody {
  summary: string;
  description: string;
  start: { date: string };
  end: { date: string }; // exclusive
  transparency: "transparent";
  source: { title: string; url: string };
}

export function buildEventBody(o: { title: string; startDate: string | null; dueDate: string | null; done: boolean; description: string; url: string; appName: string }): EventBody {
  const start = o.startDate ?? o.dueDate!;
  const last = o.dueDate ?? o.startDate!;
  return {
    summary: `${o.done ? "✓ " : ""}${o.title}`.slice(0, 300),
    description: o.description,
    start: { date: start },
    end: { date: addDays(last < start ? start : last, 1) },
    transparency: "transparent",
    source: { title: o.appName, url: o.url },
  };
}

export const payloadHash = (b: EventBody) => createHash("sha256").update(JSON.stringify(b)).digest("hex");

export function createGoogleClient(cfg: GoogleConfig, fetchImpl: typeof fetch = fetch) {
  const tokenUrl = cfg.tokenUrl ?? "https://oauth2.googleapis.com/token";
  const authUrl = cfg.authUrl ?? "https://accounts.google.com/o/oauth2/v2/auth";
  const revokeUrl = cfg.revokeUrl ?? "https://oauth2.googleapis.com/revoke";
  const apiBase = cfg.apiBase ?? "https://www.googleapis.com/calendar/v3";

  async function call(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new GoogleError("transient", 0);
    }
  }

  function classify(res: Response): GoogleError {
    const retryAfter = Number(res.headers.get("retry-after"));
    const ms = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
    if (res.status === 429) return new GoogleError("rate_limited", 429, ms);
    if (res.status === 403) return new GoogleError("rate_limited", 403, ms); // Calendar reports quota errors as 403 rateLimitExceeded
    if (res.status >= 500) return new GoogleError("transient", res.status, ms);
    if (res.status === 401) return new GoogleError("revoked", 401);
    return new GoogleError("permanent", res.status);
  }

  async function tokenRequest(params: Record<string, string>) {
    const res = await call(tokenUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, ...params }) });
    if (res.ok) return (await res.json()) as { access_token: string; expires_in: number; refresh_token?: string; scope?: string };
    let code = "";
    try { code = ((await res.json()) as { error?: string }).error ?? ""; } catch { /* ignore */ }
    if (code === "invalid_grant") throw new GoogleError("revoked", res.status);
    throw classify(res);
  }

  return {
    authorizeUrl(state: string, codeChallenge: string): string {
      const u = new URL(authUrl);
      u.search = new URLSearchParams({
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri, response_type: "code", scope: CALENDAR_SCOPE,
        access_type: "offline", prompt: "consent", include_granted_scopes: "false", state, code_challenge: codeChallenge, code_challenge_method: "S256",
      }).toString();
      return u.toString();
    },
    async exchangeCode(code: string, codeVerifier: string) {
      const r = await tokenRequest({ grant_type: "authorization_code", code, redirect_uri: cfg.redirectUri, code_verifier: codeVerifier });
      if (!r.refresh_token) throw new GoogleError("permanent", 200);
      return { accessToken: r.access_token, refreshToken: r.refresh_token, scope: r.scope ?? CALENDAR_SCOPE };
    },
    async refresh(refreshToken: string) {
      const r = await tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
      return { accessToken: r.access_token, expiresIn: r.expires_in };
    },
    async revoke(token: string) {
      try { await call(revokeUrl, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) }); } catch { /* best effort */ }
    },
    /** Creates the event, or updates it if it already exists. Idempotent for a fixed event id. */
    async upsertEvent(accessToken: string, calendarId: string, eventId: string, body: EventBody, known: boolean): Promise<"created" | "updated"> {
      const base = `${apiBase}/calendars/${encodeURIComponent(calendarId)}/events`;
      const headers = { authorization: `Bearer ${accessToken}`, "content-type": "application/json" };
      const update = async () => {
        const res = await call(`${base}/${eventId}`, { method: "PUT", headers, body: JSON.stringify({ ...body, id: eventId }) });
        return res;
      };
      const insert = async () => call(base, { method: "POST", headers, body: JSON.stringify({ ...body, id: eventId }) });
      if (known) {
        const res = await update();
        if (res.ok) return "updated";
        if (res.status !== 404) throw classify(res);
        const again = await insert();
        if (again.ok) return "created";
        throw classify(again);
      }
      const res = await insert();
      if (res.ok) return "created";
      if (res.status === 409) {
        // A previous attempt created it but we never recorded the link. Adopt it.
        const upd = await update();
        if (upd.ok) return "updated";
        throw classify(upd);
      }
      throw classify(res);
    },
    async deleteEvent(accessToken: string, calendarId: string, eventId: string): Promise<void> {
      const res = await call(`${apiBase}/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } });
      if (res.ok || res.status === 404 || res.status === 410) return; // already gone
      throw classify(res);
    },
  };
}

export type GoogleClient = ReturnType<typeof createGoogleClient>;
