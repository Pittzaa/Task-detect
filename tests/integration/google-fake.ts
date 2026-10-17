import { createHash } from "node:crypto";
import { CALENDAR_SCOPE } from "@/integrations/google-calendar";

export interface RecordedCall { method: string; path: string; auth: string | null; body?: Record<string, unknown> }

/**
 * An in-memory stand-in for the parts of Google OAuth + Calendar that we use, honouring the behaviours our code
 * depends on (client-chosen event ids, 409 on duplicate insert, 404 on update of a missing event, 410 on deleting
 * a deleted event, bearer-token checks, PKCE). It is a MOCK: passing against it is not evidence that the real
 * Google APIs behave identically.
 */
export class FakeGoogle {
  events = new Map<string, Record<string, unknown>>();
  calls: RecordedCall[] = [];
  refreshTokens = new Set<string>();
  revokedTokens: string[] = [];
  private accessTokens = new Set<string>();
  private codes = new Map<string, { challenge: string; refreshToken: string; scope: string }>();
  private n = 0;
  /** One-shot failures to inject for the next matching request, e.g. { match: "POST events", status: 429, headers } */
  failures: { match: string; status: number; headers?: Record<string, string>; body?: unknown }[] = [];
  /** Called after an event write is accepted but before the response is returned. */
  onWrite?: (method: string, eventId: string) => Promise<void> | void;
  scopeGranted = CALENDAR_SCOPE;

  /** What the user's browser would carry back: a code tied to the PKCE challenge from the authorize URL. */
  issueCode(authorizeUrl: string): string {
    const u = new URL(authorizeUrl);
    const code = `code-${++this.n}`;
    const refreshToken = `rt-${this.n}`;
    this.refreshTokens.add(refreshToken);
    this.codes.set(code, { challenge: u.searchParams.get("code_challenge") ?? "", refreshToken, scope: this.scopeGranted });
    return code;
  }

  fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method ?? "GET").toUpperCase();
    const body = typeof init.body === "string" ? init.body : init.body instanceof URLSearchParams ? init.body.toString() : undefined;
    const auth = new Headers(init.headers).get("authorization");
    const json = (status: number, data: unknown, headers: Record<string, string> = {}) => new Response(status === 204 ? null : JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

    // token endpoint
    if (url.pathname === "/token") {
      const form = new URLSearchParams(body);
      this.calls.push({ method, path: "/token", auth: null });
      if (form.get("grant_type") === "authorization_code") {
        const issued = this.codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        if (!issued || createHash("sha256").update(verifier).digest("base64url") !== issued.challenge) return json(400, { error: "invalid_grant" });
        this.codes.delete(form.get("code")!);
        const at = `at-${++this.n}`; this.accessTokens.add(at);
        return json(200, { access_token: at, expires_in: 3600, refresh_token: issued.refreshToken, scope: issued.scope });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (!this.refreshTokens.has(form.get("refresh_token") ?? "")) return json(400, { error: "invalid_grant" });
        const f = this.failures.findIndex((x) => x.match === "POST token");
        if (f >= 0) { const x = this.failures.splice(f, 1)[0]!; return json(x.status, x.body ?? {}, x.headers); }
        const at = `at-${++this.n}`; this.accessTokens.add(at);
        return json(200, { access_token: at, expires_in: 3600 });
      }
      return json(400, { error: "unsupported_grant_type" });
    }
    if (url.pathname === "/revoke") {
      this.calls.push({ method, path: "/revoke", auth: null });
      const token = new URLSearchParams(body).get("token") ?? "";
      this.revokedTokens.push(token);
      this.refreshTokens.delete(token);
      return json(200, {});
    }

    // calendar API
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(url.pathname);
    if (!m) return json(404, {});
    const [, cal, id] = m;
    const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : undefined;
    this.calls.push({ method, path: `/events${id ? "/" + id : ""}`, auth, body: parsed });
    if (!auth?.startsWith("Bearer ") || !this.accessTokens.has(auth.slice(7))) return json(401, { error: { code: 401 } });
    const key = `${decodeURIComponent(cal!)}/${id ?? parsed?.id}`;
    const f = this.failures.findIndex((x) => x.match === `${method} events`);
    if (f >= 0) { const x = this.failures.splice(f, 1)[0]!; return json(x.status, x.body ?? { error: { code: x.status } }, x.headers); }

    if (method === "POST") {
      if (this.events.has(key)) return json(409, { error: { code: 409 } });
      this.events.set(key, structuredClone(parsed!));
      await this.onWrite?.("POST", String(parsed!.id));
      return json(200, parsed);
    }
    if (method === "PUT") {
      if (!this.events.has(key)) return json(404, { error: { code: 404 } });
      this.events.set(key, structuredClone(parsed!));
      await this.onWrite?.("PUT", String(id));
      return json(200, parsed);
    }
    if (method === "DELETE") {
      if (!this.events.has(key)) return json(410, { error: { code: 410 } });
      this.events.delete(key);
      return json(204, null);
    }
    return json(405, {});
  }) as typeof fetch;

  /** Rewrites real Google hostnames to the fake handler, so production URLs are what the code builds. */
  config(redirectUri = "http://localhost:3000/api/calendar/callback") {
    return { clientId: "client-id", clientSecret: "client-secret", redirectUri, tokenUrl: "https://fake.google/token", revokeUrl: "https://fake.google/revoke", apiBase: "https://fake.google/calendar/v3" };
  }

  writes() { return this.calls.filter((c) => c.path.startsWith("/events") && c.method !== "GET"); }
  reads() { return this.calls.filter((c) => c.path.startsWith("/events") && c.method === "GET"); }
  eventList() { return [...this.events.values()]; }
}
