import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { RESET_WINDOW_SECONDS, accountRule, guardAccount, throttleAccount } from "@/server/auth-throttle";
import { POST } from "@/app/api/auth/[...all]/route";
import { Client, PASSWORD, makeAuthApp, registerAndSignIn } from "./auth-helpers";
import { connect } from "./helpers";

function base32Decode(input: string): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes).toString("utf8");
}

const c = connect();
afterAll(() => c.close());

const BASE = "http://localhost:3000/api/auth";
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const fresh = () => `victim-${randomUUID()}@example.test`;

async function attempts(n: number, make: () => Request) {
  const codes: number[] = [];
  for (let i = 0; i < n; i++) codes.push((await throttleAccount(make(), c.app))?.status ?? 0);
  return codes;
}

describe("accountRule", () => {
  it("only applies to the sign-in, e-mail-sending and two-factor routes", () => {
    expect(accountRule("/api/auth/sign-in/email", "a@b.c", null)?.key).toMatch(/^acct:signin:[0-9a-f]{64}$/);
    expect(accountRule("/api/auth/request-password-reset", "a@b.c", null)?.key).toMatch(/^acct:reset:/);
    expect(accountRule("/api/auth/send-verification-email", "a@b.c", null)?.key).toMatch(/^acct:verify:/);
    expect(accountRule("/api/auth/sign-up/email", "a@b.c", null)?.key).toMatch(/^acct:signup:/);
    expect(accountRule("/api/auth/change-password", "a@b.c", null)).toBeNull();
    expect(accountRule("/api/auth/get-session", "a@b.c", null)).toBeNull();
    expect(accountRule("/api/auth/sign-in/email", undefined, null)).toBeNull();
  });
  it("never puts the e-mail address or the pending cookie into the stored key", () => {
    const k = accountRule("/api/auth/sign-in/email", "ana@example.com", null)!.key;
    expect(k).not.toContain("ana");
    const t = accountRule("/api/auth/two-factor/verify-totp", undefined, "x=1; __Secure-better-auth.two_factor=PENDING-TOKEN.sig; y=2")!.key;
    expect(t).not.toContain("PENDING");
  });
  it("finds the pending two-factor cookie with and without the production prefix, and ignores look-alikes", () => {
    const plain = accountRule("/api/auth/two-factor/verify-totp", undefined, "better-auth.two_factor=abc");
    const secure = accountRule("/api/auth/two-factor/verify-backup-code", undefined, "a=b; __Secure-better-auth.two_factor=abc");
    expect(plain?.key).toBeTruthy();
    expect(plain?.key).toBe(secure?.key);
    expect(accountRule("/api/auth/two-factor/verify-totp", undefined, "evil-better-auth.two_factor=abc")).toBeNull();
    expect(accountRule("/api/auth/two-factor/verify-totp", undefined, "better-auth.session_token=abc")).toBeNull();
    expect(accountRule("/api/auth/two-factor/verify-totp", undefined, null)).toBeNull();
  });
});

describe("throttleAccount", () => {
  it("stops sign-in attempts against one account after 20 in a window, whatever address they claim to come from", async () => {
    const email = fresh();
    let n = 0;
    const codes = await attempts(23, () => post("/sign-in/email", { email, password: "x" }, { "x-forwarded-for": `10.0.0.${n++ % 250}` }));
    expect(codes.slice(0, 20).every((s) => s === 0)).toBe(true);
    expect(codes.slice(20)).toEqual([429, 429, 429]);
  });

  it("answers in Better Auth's error shape, with Retry-After, and does not cache", async () => {
    const email = fresh();
    await attempts(20, () => post("/sign-in/email", { email, password: "x" }));
    const res = (await throttleAccount(post("/sign-in/email", { email, password: "x" }), c.app))!;
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ message: "Too many requests. Please try again later.", code: "RATE_LIMITED" });
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(890);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(900); // the time left, not the whole window
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("counts one account no matter how its address is written, and leaves other accounts alone", async () => {
    const email = fresh();
    const other = fresh();
    for (let i = 0; i < 20; i++) await throttleAccount(post("/sign-in/email", { email: i % 2 ? email.toUpperCase() : `  ${email} `, password: "x" }), c.app);
    expect((await throttleAccount(post("/sign-in/email", { email, password: "x" }), c.app))?.status).toBe(429);
    expect(await throttleAccount(post("/sign-in/email", { email: other, password: "x" }), c.app)).toBeNull();
  });

  it("limits password-reset e-mails to one every two hours per address, however the address is written", async () => {
    const email = fresh();
    expect(await attempts(1, () => post("/request-password-reset", { email }))).toEqual([0]);
    expect(await attempts(1, () => post("/request-password-reset", { email: `  ${email.toUpperCase()} ` }))).toEqual([429]);
    expect(await attempts(2, () => post("/request-password-reset", { email }))).toEqual([429, 429]);
    expect(await attempts(1, () => post("/request-password-reset", { email: fresh() }))).toEqual([0]); // another person is not affected
    const res = (await throttleAccount(post("/request-password-reset", { email }), c.app))!;
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(7190);
    expect(Number(res.headers.get("retry-after"))).toBeLessThanOrEqual(7200);
    expect(accountRule("/api/auth/request-password-reset", email, null)).toMatchObject({ windowSeconds: RESET_WINDOW_SECONDS, max: 1, refund: "failure" });
  });

  it("limits verification e-mails to one every ten minutes and sign-ups to three an hour per address", async () => {
    const a = fresh();
    expect(await attempts(3, () => post("/send-verification-email", { email: a }))).toEqual([0, 429, 429]);
    const b = fresh();
    expect(await attempts(5, () => post("/sign-up/email", { email: b, password: "x", name: "n" }))).toEqual([0, 0, 0, 429, 429]);
    expect(await attempts(1, () => post("/sign-up/email", { email: fresh(), password: "x", name: "n" }))).toEqual([0]);
  });

  it("the limits never tell an unknown address from a known one: the key is the address, not the account", () => {
    const k = accountRule("/api/auth/request-password-reset", "ghost@example.test", null)!.key;
    expect(k).toMatch(/^acct:reset:[0-9a-f]{64}$/);
    expect(k).not.toContain("ghost");
  });

  it("limits code guesses on one pending two-factor sign-in, and a new pending sign-in starts fresh", async () => {
    const cookie = `__Secure-better-auth.two_factor=${randomUUID()}.sig`;
    const codes = await attempts(12, () => post("/two-factor/verify-totp", { code: "000000" }, { cookie }));
    expect(codes).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 429, 429]);
    expect(await throttleAccount(post("/two-factor/verify-backup-code", { code: "x" }, { cookie }), c.app)).not.toBeNull(); // shared budget
    expect(await throttleAccount(post("/two-factor/verify-totp", { code: "000000" }, { cookie: `better-auth.two_factor=${randomUUID()}.sig` }), c.app)).toBeNull();
  });

  it("ignores everything else: reads, other routes, bodies that are not JSON or have no e-mail", async () => {
    expect(await throttleAccount(new Request(`${BASE}/sign-in/email`, { method: "GET" }), c.app)).toBeNull();
    // (sign-up is a limited route now, 3 an hour per address: its own test covers that; here a route that really is left alone)
    const same = fresh();
    expect(await attempts(30, () => post("/change-password", { email: same }))).toEqual(Array(30).fill(0)); // the same address thirty times: never refused
    expect(await attempts(30, () => post("/sign-in/email", "not json"))).toEqual(Array(30).fill(0));
    expect(await attempts(30, () => post("/sign-in/email", { email: 42 }))).toEqual(Array(30).fill(0));
  });

  it("passes the request body on untouched for Better Auth to read", async () => {
    const req = post("/sign-in/email", { email: fresh(), password: "x" });
    await throttleAccount(req, c.app);
    expect((await req.json() as { password: string }).password).toBe("x");
  });
});

describe("the sign-in route itself", () => {
  it("is guarded: the 21st attempt on one account is refused before Better Auth sees it, earlier ones reach Better Auth", async () => {
    makeAuthApp(c.app, { rateLimit: false }); // Better Auth's own per-address limit off: only the account limit can answer 429
    const email = fresh();
    const statuses: number[] = [];
    for (let i = 0; i < 22; i++) statuses.push((await POST(post("/sign-in/email", { email, password: "wrong-password-123" }, { "x-forwarded-for": `10.1.0.${i}` }))).status);
    expect(statuses.slice(0, 20).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(0, 20).every((s) => s === 401 || s === 400)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
  });
});

describe("successful sign-ins do not use up the allowance", () => {
  it("only wrong guesses count: many correct sign-ins in a row are never refused, and the 21st wrong guess is", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { email } = await registerAndSignIn(app, "refund");
    const signIn = (password: string) => POST(post("/sign-in/email", { email, password }));
    const good: number[] = [];
    for (let i = 0; i < 30; i++) good.push((await signIn(PASSWORD)).status);
    expect(good).toEqual(Array(30).fill(200));

    const bad: number[] = [];
    for (let i = 0; i < 19; i++) bad.push((await signIn("wrong-password-123")).status);
    for (let i = 0; i < 5; i++) expect((await signIn(PASSWORD)).status).toBe(200); // correct ones in between are given back
    bad.push((await signIn("wrong-password-123")).status); // the 20th wrong guess is still answered by Better Auth
    expect(bad.every((s) => s === 401)).toBe(true);
    expect((await signIn("wrong-password-123")).status).toBe(429);
    expect((await signIn(PASSWORD)).status).toBe(429); // an exhausted allowance holds until the window ends, even for the right password
  });

  it("does not give back a password-reset request (the harm there is the e-mail itself)", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { email } = await registerAndSignIn(app, "reset-norefund");
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await POST(post("/request-password-reset", { email, redirectTo: "http://localhost:3000/reset" }))).status);
    expect(codes).toEqual([200, 429, 429, 429]);
  });
});

describe("against Better Auth's real two-factor sign-in", () => {
  it("the pending-sign-in cookie it sets is the one the limit looks for", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { client, email } = await registerAndSignIn(app, "mfa-throttle");
    const en = await client.authCall("POST", "/two-factor/enable", { password: PASSWORD });
    const { totpURI } = (await en.json()) as { totpURI: string };
    const { createOTP } = await import("@better-auth/utils/otp");
    await client.authCall("POST", "/two-factor/verify-totp", { code: await createOTP(base32Decode(new URL(totpURI).searchParams.get("secret")!)).totp() });

    const fresh = new Client(app.auth);
    const si = await fresh.authCall("POST", "/sign-in/email", { email, password: PASSWORD });
    expect(((await si.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    const cookieHeader = [...fresh.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    expect(accountRule("/api/auth/two-factor/verify-totp", undefined, cookieHeader)).not.toBeNull();
  });
});

describe("bodies Better Auth understands but the limit could not read", () => {
  const ctype = (type: string, body: string, path = "/sign-in/email") => new Request(`${BASE}${path}`, { method: "POST", headers: type ? { "content-type": type } : {}, body });
  const form = (email: string) => `email=${encodeURIComponent(email)}&password=wrong-password-123`;

  it("a form-encoded sign-in, which Better Auth would process, is refused before it can be used to guess without limit", async () => {
    makeAuthApp(c.app, { rateLimit: false });
    const email = fresh();
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await POST(ctype("application/x-www-form-urlencoded", form(email)))).status);
    expect(statuses).toEqual(Array(25).fill(415));
  });

  it("the same for the password-reset request, and for a missing or unusual content type", async () => {
    makeAuthApp(c.app, { rateLimit: false });
    const email = fresh();
    expect((await POST(ctype("application/x-www-form-urlencoded", `email=${encodeURIComponent(email)}`, "/request-password-reset"))).status).toBe(415);
    for (const type of ["multipart/form-data; boundary=x", "text/plain", ""]) {
      expect((await POST(ctype(type, JSON.stringify({ email, password: "x" })))).status, type || "(none)").toBe(415);
    }
  });

  it("JSON in its usual spellings still reaches Better Auth and is counted", async () => {
    makeAuthApp(c.app, { rateLimit: false });
    const email = fresh();
    for (const type of ["application/json", "application/json; charset=utf-8", "APPLICATION/JSON"]) {
      const res = await POST(ctype(type, JSON.stringify({ email, password: "wrong-password-123" })));
      expect(res.status, type).toBe(401);
    }
    const counted = await c.app.execute(sql`select count from app_rate_limits where key = ${accountRule("/api/auth/sign-in/email", email, null)!.key}`);
    expect((counted as unknown as { rows: { count: number }[] }).rows[0]!.count).toBe(3);
  });

  it("other routes are left alone: nothing is rewritten, refused or counted", async () => {
    let ran = 0;
    const res = await guardAccount(ctype("application/x-www-form-urlencoded", "x=1", "/change-password"), c.app, async () => { ran++; return new Response("ok"); });
    expect(res.status).toBe(200);
    expect(ran).toBe(1);
  });
});

describe("an e-mail allowance is spent only by a request that sends an e-mail", () => {
  const RESET = (email: string, extra: Record<string, unknown> = {}) => post("/request-password-reset", { email, redirectTo: "http://localhost:3000/reset", ...extra });
  const countOf = async (key: string) => ((await c.app.execute(sql`select count from app_rate_limits where key = ${key}`)) as unknown as { rows: { count: number }[] }).rows[0]?.count ?? 0;

  // The throttle trims and lower-cases the address it counts; Better Auth's own validation does not, so a request that names a person with a
  // padded address is counted for that person by the throttle and then refused (400) by Better Auth without sending anything.
  const padded = (email: string) => ` ${email}`;

  it("a request Better Auth refuses leaves the person's allowance intact, so it cannot be used to lock them out", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { email } = await registerAndSignIn(app, "lockout");
    const key = accountRule("/api/auth/request-password-reset", email, null)!.key;
    const before = app.email.sent.length;
    const refused = await POST(RESET(padded(email)));
    expect(refused.ok).toBe(false);
    expect(await countOf(key)).toBe(0); // given back: it sent nothing
    expect(app.email.sent.length).toBe(before);
    // the allowance still covers one real request, which sends, and then the next is refused
    const ok = await POST(RESET(email));
    expect(ok.status).toBe(200);
    expect(app.email.sent.length).toBe(before + 1);
    expect((await POST(RESET(email))).status).toBe(429);
    expect(await countOf(key)).toBe(1); // refusals are not counted either
  });

  it("two bad requests in parallel do not lock the person out either", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { email } = await registerAndSignIn(app, "parallel");
    await Promise.all([POST(RESET(padded(email))), POST(RESET(`  ${email}`)), POST(RESET(padded(email)))]);
    expect((await POST(RESET(email))).status).toBe(200);
  });

  it("verification and sign-up allowances survive requests that send nothing (a padded address, a too-short password)", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const email = fresh();
    expect((await POST(post("/sign-up/email", { email, password: "short", name: "N" }))).ok).toBe(false);
    expect((await POST(post("/send-verification-email", { email: padded(email) }))).ok).toBe(false);
    expect(await countOf(accountRule("/api/auth/sign-up/email", email, null)!.key)).toBe(0);
    expect(await countOf(accountRule("/api/auth/send-verification-email", email, null)!.key)).toBe(0);
    expect((await POST(post("/sign-up/email", { email, password: PASSWORD, name: "N" }))).status).toBe(200);
    expect(app.email.sent.some((m) => m.to === email)).toBe(true);
  });

  it("a send that fails after the unit was taken gives it back: the provider being down does not cost the person two hours", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { email } = await registerAndSignIn(app, "provider-down");
    const { EmailError } = await import("@/integrations/email");
    app.email.failNext = new EmailError("provider down", true);
    expect((await POST(RESET(email))).status).toBe(200); // Better Auth swallows the failure and answers as usual
    const sentBefore = app.email.sent.length;
    expect((await POST(RESET(email))).status).toBe(200); // not refused: the first one never left
    expect(app.email.sent.length).toBe(sentBefore + 1);
  });

  it("using the reset link ends the wait: the person can ask for another one at once, and only then", async () => {
    const app = makeAuthApp(c.app, { rateLimit: false });
    const { email } = await registerAndSignIn(app, "link-used");
    expect((await POST(RESET(email))).status).toBe(200);
    expect((await POST(RESET(email))).status).toBe(429);
    const mail = app.email.sent.filter((m) => m.to === email).at(-1)!;
    const token = new URL(/https?:\/\/\S+/.exec(mail.text)![0].replace(/[).,]+$/, "")).pathname.split("/").pop()!;
    expect((await POST(post("/reset-password", { newPassword: "a-brand-new-password-1", token }))).status).toBe(200);
    expect((await POST(RESET(email))).status).toBe(200);
  });
});
