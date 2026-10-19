import { ZodError, type ZodType } from "zod";
import { AppError, notFound, unauthenticated, validation } from "@/lib/errors";
import { after } from "next/server";
import { reportError } from "@/lib/error-report";
import { withTenant, type TenantSession } from "@/data/tenant";
import type { Db } from "@/db/client";
import { kick } from "@/jobs/kick";
import { consumeRateLimit } from "./rate-limit";
import { getRuntime, type Runtime } from "./runtime";

export interface ApiUser {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  locale: "th" | "en";
  timezone: string;
}

export interface ApiContext {
  req: Request;
  rt: Runtime;
  db: Db;
  user: ApiUser;
  /** When this browser session was created (used to require a recent sign-in for destructive account actions). */
  sessionCreatedAt: Date;
  /** Opens a tenant session. The org id is only a *request*; membership is verified server-side. */
  tenant<T>(orgId: string, fn: (s: TenantSession) => Promise<T>): Promise<T>;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_BODY_BYTES = 1_000_000;

/** CSRF defence for cookie-authenticated requests: mutating calls must come from our own origin. */
export function assertSameOrigin(req: Request, appUrl: string) {
  if (SAFE_METHODS.has(req.method)) return;
  const allowed = new URL(appUrl).origin;
  const origin = req.headers.get("origin");
  if (origin !== allowed) throw new AppError("FORBIDDEN", "Cross-origin request blocked", 403);
}

/**
 * PostgreSQL text cannot contain the NUL character, and the driver reports it as an internal error (HTTP 500). It is never
 * legitimate input, so it is rejected at the boundary as a validation error. Iterative walk: hostile nesting cannot overflow the stack.
 */
export function hasNul(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === "string") { if (v.includes("\u0000")) return true; }
    else if (Array.isArray(v)) { for (const x of v) stack.push(x); } // not push(...v): a long array would overflow the call stack
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k.includes("\u0000")) return true; stack.push(x); }
  }
  return false;
}
export const NUL_MESSAGE = "Text contains an unsupported character";

export async function readJson<T>(req: Request, schema: ZodType<T>): Promise<T> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > MAX_BODY_BYTES) throw validation("Request body too large");
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw validation("Request body too large");
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    throw validation("Invalid JSON");
  }
  if (hasNul(raw)) throw validation(NUL_MESSAGE);
  return schema.parse(raw);
}

export function readQuery<T>(req: Request, schema: ZodType<T>): T {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  return schema.parse(params);
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;
/** A caller-supplied id is only kept if it is a harmless token (log-injection safe); otherwise a fresh one is made. */
export function requestIdFor(req: Request): string {
  const given = req.headers.get("x-request-id");
  return given && REQUEST_ID.test(given) ? given : crypto.randomUUID();
}

function errorResponse(e: unknown, req: Request, requestId?: string): Response {
  if (e instanceof ZodError) {
    return json({ error: { code: "VALIDATION", message: "Invalid input", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, 422);
  }
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } }, e.status);
  reportError(e, { kind: "api", requestId, method: req.method, path: new URL(req.url).pathname }, (p) => after(() => p));
  return json({ error: { code: "INTERNAL", message: "Internal error" } }, 500);
}

/**
 * Without a per-minute scheduler (Vercel Hobby) the background work also runs when the app is used: once the response has gone out, a
 * signed-in request lets the worker handle what is due (src/jobs/kick.ts). With a scheduler it finds little to do. Outside a request
 * (unit tests) there is nothing to hook into.
 */
function kickAfterResponse(rt: Runtime) {
  try { after(() => kick(rt.jobContext())); } catch { /* not inside a request */ }
}

/**
 * Wraps a route handler: same-origin check, authentication, uniform error mapping.
 * `auth: false` is for the few public endpoints and must be a deliberate choice.
 */
export async function handle(
  req: Request,
  fn: (c: ApiContext) => Promise<unknown>,
  opts: { status?: number; /** Per-user fixed-window limit for abusable endpoints, in addition to the auth-layer limits. */ limit?: { name: string; windowSeconds: number; max: number } } = {},
): Promise<Response> {
  const requestId = requestIdFor(req);
  const res = await handleInner(req, fn, opts, requestId);
  try { res.headers.set("x-request-id", requestId); } catch { /* immutable response from a lower layer: the id is only a convenience */ }
  return res;
}

async function handleInner(req: Request, fn: (c: ApiContext) => Promise<unknown>, opts: { status?: number; limit?: { name: string; windowSeconds: number; max: number } }, requestId: string): Promise<Response> {
  try {
    const rt = getRuntime();
    assertSameOrigin(req, rt.appUrl);
    const session = await rt.auth.api.getSession({ headers: req.headers });
    if (!session) throw unauthenticated();
    if (/%00/i.test(req.url) || req.url.includes("\u0000")) throw validation(NUL_MESSAGE);
    const u = session.user as unknown as ApiUser;
    if (opts.limit) await consumeRateLimit(rt.db, `${opts.limit.name}:${u.id}`, opts.limit.windowSeconds, opts.limit.max);
    const user: ApiUser = { id: u.id, email: u.email, emailVerified: u.emailVerified, name: u.name, locale: u.locale ?? "th", timezone: u.timezone ?? "Asia/Bangkok" };
    const ctx: ApiContext = {
      req, rt, db: rt.db, user, sessionCreatedAt: new Date((session.session as { createdAt: Date | string }).createdAt),
      tenant: (orgId, f) => {
        if (!UUID.test(orgId)) throw notFound();
        return withTenant(rt.db, { userId: user.id, orgId }, f);
      },
    };
    const result = await fn(ctx);
    kickAfterResponse(rt);
    if (result instanceof Response) return result;
    return json(result ?? { ok: true }, opts.status ?? 200);
  } catch (e) {
    return errorResponse(e, req, requestId);
  }
}
