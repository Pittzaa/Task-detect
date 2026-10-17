import { ZodError, type ZodType } from "zod";
import { AppError, notFound, unauthenticated, validation } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { withTenant, type TenantSession } from "@/data/tenant";
import type { Db } from "@/db/client";
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

function errorResponse(e: unknown): Response {
  if (e instanceof ZodError) {
    return json({ error: { code: "VALIDATION", message: "Invalid input", issues: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } }, 422);
  }
  if (e instanceof AppError) return json({ error: { code: e.code, message: e.message } }, e.status);
  logger.error({ err: e instanceof Error ? e.message : "unknown" }, "unhandled API error");
  return json({ error: { code: "INTERNAL", message: "Internal error" } }, 500);
}

/**
 * Wraps a route handler: same-origin check, authentication, uniform error mapping.
 * `auth: false` is for the few public endpoints and must be a deliberate choice.
 */
export async function handle(req: Request, fn: (c: ApiContext) => Promise<unknown>, opts: { status?: number } = {}): Promise<Response> {
  try {
    const rt = getRuntime();
    assertSameOrigin(req, rt.appUrl);
    const session = await rt.auth.api.getSession({ headers: req.headers });
    if (!session) throw unauthenticated();
    const u = session.user as unknown as ApiUser;
    const user: ApiUser = { id: u.id, email: u.email, emailVerified: u.emailVerified, name: u.name, locale: u.locale ?? "th", timezone: u.timezone ?? "Asia/Bangkok" };
    const ctx: ApiContext = {
      req, rt, db: rt.db, user,
      tenant: (orgId, f) => {
        if (!UUID.test(orgId)) throw notFound();
        return withTenant(rt.db, { userId: user.id, orgId }, f);
      },
    };
    const result = await fn(ctx);
    if (result instanceof Response) return result;
    return json(result ?? { ok: true }, opts.status ?? 200);
  } catch (e) {
    return errorResponse(e);
  }
}
