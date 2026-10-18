import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { sha256Hex } from "@/lib/crypto";
import { consumeRateLimit } from "./rate-limit";
import { AppError } from "@/lib/errors";

interface Rule { key: string; windowSeconds: number; max: number; /** A successful answer gives the attempt back, so only failures use up the allowance. */ refundOnSuccess: boolean }

/**
 * Better Auth throttles by client address, which comes from X-Forwarded-For. Behind Vercel the platform sets that header; anywhere
 * else a client can send a different value with every request and the per-address limit stops counting. These limits do not depend
 * on the address: they follow the account (or the pending two-factor sign-in) being attacked. The numbers are generous on purpose,
 * because anyone who knows an e-mail address can use up its allowance and so delay that person's sign-in until the window ends.
 */
export function accountRule(path: string, email: string | undefined, cookieHeader: string | null): Rule | null {
  if (email && path.endsWith("/sign-in/email")) return { key: `acct:signin:${sha256Hex(email)}`, windowSeconds: 15 * 60, max: 20, refundOnSuccess: true };
  if (email && path.endsWith("/request-password-reset")) return { key: `acct:reset:${sha256Hex(email)}`, windowSeconds: 3600, max: 5, refundOnSuccess: false };
  if (path.endsWith("/two-factor/verify-totp") || path.endsWith("/two-factor/verify-backup-code")) {
    const pending = cookieHeader?.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.two_factor=([^;]+)/)?.[1];
    if (pending) return { key: `acct:2fa:${sha256Hex(pending)}`, windowSeconds: 10 * 60, max: 10, refundOnSuccess: true };
  }
  return null;
}

/** The same test Better Auth's body parser uses to decide that a body is JSON. */
const JSON_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;
const EMAIL_PATHS = ["/sign-in/email", "/request-password-reset"];

/** False when the request is one the per-account limits key on the e-mail address of, but not in a form they can read. */
function readsEmailFromJson(req: Request): boolean {
  if (req.method !== "POST") return true;
  const path = new URL(req.url).pathname;
  if (!EMAIL_PATHS.some((p) => path.endsWith(p))) return true;
  return JSON_TYPE.test((req.headers.get("content-type") ?? "").trim());
}

async function ruleFor(req: Request): Promise<Rule | null> {
  if (req.method !== "POST") return null;
  const path = new URL(req.url).pathname;
  let email: string | undefined;
  if (EMAIL_PATHS.some((p) => path.endsWith(p))) {
    const body = (await req.clone().json().catch(() => null)) as { email?: unknown } | null;
    if (typeof body?.email === "string") email = body.email.trim().toLowerCase().slice(0, 320);
  }
  return accountRule(path, email, req.headers.get("cookie"));
}

/** Returns a 429 in Better Auth's error shape when the account behind this request has used up its allowance, otherwise null. */
export async function throttleAccount(req: Request, db: Db): Promise<Response | null> {
  const rule = await ruleFor(req);
  return rule ? consume(rule, db) : null;
}

async function consume(rule: Rule, db: Db): Promise<Response | null> {
  try {
    await consumeRateLimit(db, rule.key, rule.windowSeconds, rule.max);
    return null;
  } catch (e) {
    if (e instanceof AppError && e.code === "RATE_LIMITED") {
      return Response.json({ message: "Too many requests. Please try again later.", code: "RATE_LIMITED" }, { status: 429, headers: { "cache-control": "no-store", "retry-after": String(rule.windowSeconds) } });
    }
    throw e;
  }
}

/**
 * Takes the attempt before Better Auth runs (atomically, so parallel guesses cannot slip under the limit) and gives it back when the
 * answer is a success: signing in correctly, even many times in a row, never uses up the allowance; only wrong guesses do.
 */
export async function guardAccount(req: Request, db: Db, run: () => Promise<Response>): Promise<Response> {
  if (!readsEmailFromJson(req)) {
    // Better Auth also accepts form-encoded bodies on these two routes; the limits below only read JSON, so a form body would
    // have been counted nowhere. The application only ever sends JSON.
    return Response.json({ message: "Send this request as application/json.", code: "UNSUPPORTED_MEDIA_TYPE" }, { status: 415, headers: { "cache-control": "no-store" } });
  }
  const rule = await ruleFor(req);
  if (!rule) return run();
  const refused = await consume(rule, db);
  if (refused) return refused;
  const res = await run();
  if (rule.refundOnSuccess && res.ok) {
    await db.execute(sql`update app_rate_limits set count = greatest(count - 1, 0) where key = ${rule.key}`).catch(() => undefined);
  }
  return res;
}
