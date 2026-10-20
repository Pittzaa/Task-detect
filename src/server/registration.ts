import { and, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@/db/client";
import { invitations, organizations } from "@/db/schema";
import { withWorker, withWorkerOrg } from "@/jobs/context";
import { displayNameSchema, imageSchema } from "@/lib/profile-fields";
import { JSON_TYPE } from "./auth-throttle";
import { takeRateLimit } from "./rate-limit";

export interface RegistrationState {
  /** Organizations that exist. This product is meant to run with exactly one. */
  organizations: number;
  /** Whether a person without an invitation may sign up (no organization yet, or at least one that allows it). */
  open: boolean;
}

/** One cheap read, usable before anybody is signed in. Reveals only counts and a flag. */
export async function registrationState(db: Db): Promise<RegistrationState> {
  const orgs = await liveOrgs(db);
  return { organizations: orgs.length, open: orgs.length === 0 || orgs.some((o) => o.open) };
}

/**
 * May this address create an account? Yes while registration is open; once an administrator closes it, only for an address
 * that holds a valid, unused invitation (that is how the first administrator and later invitees get in). Checked when the
 * user row is created, so it covers e-mail sign-up and Google sign-in alike.
 */
export async function canRegister(db: Db, email: string): Promise<boolean> {
  const orgs = await liveOrgs(db);
  if (orgs.length === 0 || orgs.some((o) => o.open)) return true;
  const address = email.trim().toLowerCase();
  const now = new Date();
  for (const org of orgs) {
    const [hit] = await withWorkerOrg(db, org.id, (tx) =>
      tx
        .select({ id: invitations.id })
        .from(invitations)
        .where(and(eq(invitations.orgId, org.id), eq(invitations.email, address), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)))
        .limit(1),
    );
    if (hit) return true;
  }
  return false;
}

/** Sign-up attempts that may be made per hour, all callers together, while registration is closed (see guardSignUp). */
export const CLOSED_SIGNUP_PER_HOUR = 60;

const refuse = (status: number, code: string, message: string, headers: Record<string, string> = {}) =>
  Response.json({ message, code }, { status, headers: { "cache-control": "no-store", ...headers } });

/**
 * In front of Better Auth's sign-up route. Three things, in this order, each answering the same way whatever the address is:
 *  1. The body must be JSON. Better Auth also reads form bodies, which would walk round everything below.
 *  2. Name and image are judged here (the creation hook in auth.ts still does too). Better Auth only reaches that hook for an
 *     address that has no account yet, so judging inside it would tell a caller which addresses are registered.
 *  3. While registration is closed, an address without an invitation gets an honest 403 instead of the look-alike "check your
 *     e-mail" answer Better Auth gives when it quietly declines to create an account. That answer would also tell the caller
 *     whether an address has a pending invitation, so every attempt while closed, invited or not, takes from one shared hourly
 *     allowance and gets 429 once it is used up. Nothing about the address is revealed to a caller who is over the allowance,
 *     and the allowance does not depend on the caller's address (which a caller can forge).
 */
export async function guardSignUp(req: Request, db: Db): Promise<Response | null> {
  if (req.method !== "POST" || !new URL(req.url).pathname.endsWith("/sign-up/email")) return null;
  if (!JSON_TYPE.test((req.headers.get("content-type") ?? "").trim())) {
    return refuse(415, "UNSUPPORTED_MEDIA_TYPE", "Send this request as application/json.");
  }
  const body = (await req.clone().json().catch(() => null)) as { email?: unknown; name?: unknown; image?: unknown } | null;
  if (typeof body?.email !== "string") return null; // Better Auth says what is wrong with it
  if (!displayNameSchema.safeParse(body.name).success) return refuse(400, "INVALID_NAME", "Name must be 1-100 characters without control characters");
  if (body.image !== undefined && body.image !== null && !imageSchema.safeParse(body.image).success) return refuse(400, "INVALID_IMAGE", "Image address is too long");
  if ((await registrationState(db)).open) return null;
  const slot = await takeRateLimit(db, "signup:closed", 3600, CLOSED_SIGNUP_PER_HOUR);
  if (!slot.allowed) {
    // when the allowance is back, not a flat hour: the window began at the first attempt
    const wait = Math.max(1, Math.ceil((slot.resetAt.getTime() - Date.now()) / 1000));
    return refuse(429, "RATE_LIMITED", "Too many requests. Please try again later.", { "retry-after": String(wait) });
  }
  if (await canRegister(db, body.email)) return null;
  return refuse(403, "REGISTRATION_CLOSED", "Registration is closed");
}

/** The organization a person without a code is asking to join: only well defined while exactly one organization exists. */
export async function soleOrganization(db: Db): Promise<{ id: string; open: boolean } | null> {
  const orgs = await liveOrgs(db);
  return orgs.length === 1 ? orgs[0]! : null;
}

function liveOrgs(db: Db) {
  return withWorker(db, (tx) =>
    tx.select({ id: organizations.id, open: organizations.registrationOpen }).from(organizations).where(isNull(organizations.deletedAt)).limit(50),
  );
}
