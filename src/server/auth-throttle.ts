import type { Db } from "@/db/client";
import { sha256Hex } from "@/lib/crypto";
import { refundRateLimit, takeRateLimit } from "./rate-limit";

/** A password-reset e-mail may be requested once in this long for each address. The link in it lasts as long (auth.ts), so an unused link stays usable until the next request is allowed; using it frees the allowance (auth.ts onPasswordReset). */
export const RESET_WINDOW_SECONDS = 2 * 60 * 60;

/**
 * `refund`: "success" gives the attempt back when Better Auth answers with a success (sign-in: only wrong guesses count); "failure" gives it back
 * when it does not (an e-mail route: a request Better Auth refuses before sending anything, a wrong origin or a malformed body, must not use
 * up the allowance of the person it names). Attempts this limit itself refuses are never counted.
 */
interface Rule { key: string; windowSeconds: number; max: number; refund: "success" | "failure" | null }

/**
 * Better Auth throttles by client address, which comes from X-Forwarded-For. Behind Vercel the platform sets that header; anywhere
 * else a client can send a different value with every request and the per-address limit stops counting. These limits do not depend
 * on the address: they follow the account (or the pending two-factor sign-in) being attacked. The numbers are generous on purpose,
 * because anyone who knows an e-mail address can use up its allowance and so delay that person's sign-in until the window ends.
 */
/** The key of an address's password-reset allowance (also freed when a reset link is used, see auth.ts). */
export const resetKey = (email: string) => `acct:reset:${sha256Hex(email.trim().toLowerCase().slice(0, 320))}`;
/** The key of an address's verification-e-mail allowance. */
export const verifyKey = (email: string) => `acct:verify:${sha256Hex(email.trim().toLowerCase().slice(0, 320))}`;

export function accountRule(path: string, email: string | undefined, cookieHeader: string | null): Rule | null {
  if (email && path.endsWith("/sign-in/email")) return { key: `acct:signin:${sha256Hex(email)}`, windowSeconds: 15 * 60, max: 20, refund: "success" };
  // Every route that makes us send an e-mail is limited per address, so nobody can fill a person's inbox, whatever address they come from.
  // Counted whether or not the address has an account, so the answer never tells the two apart.
  if (email && path.endsWith("/request-password-reset")) return { key: resetKey(email), windowSeconds: RESET_WINDOW_SECONDS, max: 1, refund: "failure" };
  if (email && path.endsWith("/send-verification-email")) return { key: verifyKey(email), windowSeconds: 10 * 60, max: 1, refund: "failure" };
  if (email && path.endsWith("/sign-up/email")) return { key: `acct:signup:${sha256Hex(email)}`, windowSeconds: 3600, max: 3, refund: "failure" };
  if (path.endsWith("/two-factor/verify-totp") || path.endsWith("/two-factor/verify-backup-code")) {
    const pending = cookieHeader?.match(/(?:^|;\s*)(?:__Secure-)?better-auth\.two_factor=([^;]+)/)?.[1];
    if (pending) return { key: `acct:2fa:${sha256Hex(pending)}`, windowSeconds: 10 * 60, max: 10, refund: "success" };
  }
  return null;
}

/** The same test Better Auth's body parser uses to decide that a body is JSON. */
export const JSON_TYPE = /^application\/([a-z0-9.+-]*\+)?json/i;
const EMAIL_PATHS = ["/sign-in/email", "/request-password-reset", "/send-verification-email", "/sign-up/email"];

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
  const r = await takeRateLimit(db, rule.key, rule.windowSeconds, rule.max);
  if (r.allowed) return null;
  await refundRateLimit(db, rule.key).catch(() => undefined); // an attempt that is refused is not counted, so refusals never prolong a lock
  const wait = Math.max(1, Math.ceil((r.resetAt.getTime() - Date.now()) / 1000));
  return Response.json({ message: "Too many requests. Please try again later.", code: "RATE_LIMITED" }, { status: 429, headers: { "cache-control": "no-store", "retry-after": String(wait) } });
}

/**
 * Takes the attempt before Better Auth runs (atomically, so parallel guesses cannot slip under the limit). Sign-in gives it back when the
 * answer is a success: signing in correctly, even many times in a row, never uses up the allowance; only wrong guesses do. The e-mail routes
 * give it back when the answer is NOT a success: a request Better Auth refuses (wrong origin, malformed body) sent nothing, so it cannot
 * be used to lock the person it names out of their reset or verification e-mail.
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
  if ((rule.refund === "success" && res.ok) || (rule.refund === "failure" && !res.ok)) await refundRateLimit(db, rule.key).catch(() => undefined);
  return res;
}
