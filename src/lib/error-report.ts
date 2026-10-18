import { randomUUID } from "node:crypto";
import { logger } from "./logger";

/**
 * Error description that is safe to log or send to an error-tracking service.
 *
 * Database driver errors embed the bound parameters in their message ("Failed query: … params: <user text>"), so a raw
 * `error.message` can contain task titles, e-mail addresses or other user content. This keeps the error class, the
 * database error code and constraint/table names, and a message truncated BEFORE any parameter dump.
 */
export interface SafeError { name: string; message: string; code?: string; constraint?: string; table?: string; status?: number; frames?: string[] }

const MAX_MESSAGE = 300;

function scrub(message: string): string {
  const cut = message.split(/\n?\s*params:/i)[0]!.replace(/^Failed query:[\s\S]*$/i, "database query failed");
  return cut.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE);
}

/**
 * PostgreSQL's own messages quote the offending value ("invalid input syntax for type uuid: \"<user text>\""), so for database
 * errors the text is not kept at all: the SQLSTATE code, its meaning and the constraint/table names (schema identifiers, not
 * data) are enough to diagnose.
 */
const SQLSTATE = /^(?=.*\d)[0-9A-Z]{5}$/;
const SQLSTATE_LABEL: Record<string, string> = {
  "23502": "not-null violation", "23503": "foreign key violation", "23505": "unique violation", "23514": "check violation", "23P01": "exclusion violation",
  "22P02": "invalid text representation", "22001": "value too long", "22003": "numeric out of range", "22007": "invalid datetime", "22021": "invalid byte sequence",
  "40001": "serialization failure", "40P01": "deadlock detected", "55P03": "lock not available", "57014": "query canceled", "53300": "too many connections",
  "42501": "insufficient privilege or row-level security", "42P01": "undefined table", "42703": "undefined column", "08006": "connection failure", "57P01": "admin shutdown",
};

export function describeError(e: unknown): SafeError {
  if (!(e instanceof Error)) return { name: "NonError", message: typeof e === "string" ? "string thrown" : "unknown" };
  const cause = (e as { cause?: unknown }).cause;
  const src = (cause && typeof cause === "object" ? cause : e) as { code?: unknown; constraint?: unknown; table?: unknown; status?: unknown };
  // Production builds minify class names ("e"); fall back to the Error's own name, and name database failures as such.
  const out: SafeError = { name: e.constructor.name.length > 2 ? e.constructor.name : e.name || "Error", message: scrub(e.message) };
  if (typeof src.code === "string") out.code = src.code.slice(0, 20);
  if (out.code && SQLSTATE.test(out.code)) { out.name = "DatabaseError"; out.message = `database error ${out.code}: ${SQLSTATE_LABEL[out.code] ?? "see code"}`; }
  else if (cause instanceof Error && /^Failed query/i.test(e.message)) out.message = "database query failed";
  if (typeof src.constraint === "string") out.constraint = src.constraint.slice(0, 80);
  if (typeof src.table === "string") out.table = src.table.slice(0, 80);
  if (typeof src.status === "number") out.status = src.status;
  // Only real "at …" lines: the stack text starts with the full message, which can span several lines and carry the parameters.
  if (e.stack) out.frames = e.stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at ")).slice(0, 8).map((l) => l.replace(/\(?(?:file:\/\/)?\/[^)\s]*node_modules\//, "(node_modules/").slice(0, 200));
  return out;
}

export interface ErrorContext {
  kind: "api" | "render" | "job" | "action" | "other";
  requestId?: string;
  method?: string;
  /** Path only: the query string is dropped because it can carry user input. */
  path?: string;
  route?: string;
}

/** `https://<key>@<host>/<project>` → the envelope endpoint and key. Returns null for anything that is not a well-formed https DSN. */
export function parseDsn(dsn: string | undefined): { endpoint: string; key: string } | null {
  if (!dsn) return null;
  try {
    const u = new URL(dsn);
    const project = u.pathname.replace(/^\/+|\/+$/g, "").split("/").pop();
    if (u.protocol !== "https:" || !u.username || !project || !/^\d+$/.test(project)) return null;
    const prefix = u.pathname.replace(/\/+$/g, "").split("/").slice(0, -1).join("/");
    return { endpoint: `https://${u.host}${prefix}/api/${project}/envelope/`, key: decodeURIComponent(u.username) };
  } catch { return null; }
}

export interface ReporterOptions { dsn?: string; environment?: string; release?: string; fetchImpl?: typeof fetch; now?: () => number; maxPerMinute?: number }

/** Sends events to a Sentry-compatible endpoint. Never throws, never blocks the caller beyond a short timeout, never floods. */
export function createReporter(o: ReporterOptions = {}) {
  const target = parseDsn(o.dsn);
  const fetchImpl = o.fetchImpl ?? fetch;
  const now = o.now ?? Date.now;
  const max = o.maxPerMinute ?? 20;
  const recent = new Map<string, number>();
  let windowStart = 0;
  let sentInWindow = 0;

  function admit(fingerprint: string): boolean {
    const t = now();
    if (t - windowStart > 60_000) { windowStart = t; sentInWindow = 0; recent.clear(); }
    if (recent.has(fingerprint) || sentInWindow >= max) return false; // identical error within a minute, or over budget
    recent.set(fingerprint, t);
    sentInWindow++;
    return true;
  }

  return {
    enabled: !!target,
    /** Returns a promise that resolves when the delivery attempt is over (so callers can hand it to `after()`). */
    async report(err: SafeError, ctx: ErrorContext): Promise<void> {
      if (!target) return;
      if (!admit(`${err.name}|${err.code ?? ""}|${err.constraint ?? ""}|${err.message}|${ctx.route ?? ctx.path ?? ""}`)) return;
      const eventId = randomUUID().replace(/-/g, "");
      const event = {
        event_id: eventId, timestamp: now() / 1000, platform: "node", level: "error", environment: o.environment, release: o.release,
        exception: { values: [{ type: err.name, value: err.message }] },
        tags: { kind: ctx.kind, ...(ctx.requestId ? { request_id: ctx.requestId } : {}), ...(ctx.route ? { route: ctx.route } : {}), ...(err.code ? { db_code: err.code } : {}) },
        request: { method: ctx.method, url: ctx.path },
        extra: { constraint: err.constraint, table: err.table, frames: err.frames },
      };
      const body = [JSON.stringify({ event_id: eventId, sent_at: new Date(now()).toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
      try {
        await fetchImpl(target.endpoint, {
          method: "POST", body, redirect: "error", signal: AbortSignal.timeout(3000),
          headers: { "content-type": "application/x-sentry-envelope", "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${target.key}, sentry_client=task-tracker/1.0` },
        });
      } catch (e) {
        logger.warn({ error: describeError(e).name }, "error report could not be delivered");
      }
    },
  };
}

let shared: ReturnType<typeof createReporter> | undefined;
function reporter() {
  shared ??= createReporter({ dsn: process.env.SENTRY_DSN, environment: process.env.APP_ENV ?? process.env.NODE_ENV, release: process.env.APP_RELEASE ?? process.env.VERCEL_GIT_COMMIT_SHA });
  return shared;
}
/** Test seam. */
export function setReporterForTests(r: ReturnType<typeof createReporter> | undefined) { shared = r; }

/**
 * The single place unexpected errors go: always a redacted log line, and, when SENTRY_DSN is set, a report to the tracker.
 * `deferred` lets the caller keep the function alive until delivery finishes (Next's `after()` on Vercel).
 */
export function reportError(e: unknown, ctx: ErrorContext, deferred?: (p: Promise<unknown>) => void): SafeError {
  const safe = describeError(e);
  logger.error({ ...ctx, error: safe }, "unexpected error"); // not `err`: pino's serializer for that key expects a real Error
  const r = reporter();
  if (r.enabled) {
    const p = r.report(safe, ctx).catch(() => undefined);
    if (deferred) { try { deferred(p); } catch { /* outside a request scope */ } }
  }
  return safe;
}
